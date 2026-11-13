// backend/src/routes/recordings.ts
//
// HTTP layer for the Recordings & Transcription capability. Thin router over the
// already-tested lib layer (lib/recordings/*): capture create + enqueue, the
// library list/detail reads, a signed audio URL, metadata patch, action-item
// toggle, and delete. The transcription worker (lib/recordings/scheduler +
// pipeline) drives every row from queued → ready out of band; nothing here
// blocks on it.
//
// Mirrors routes/email.ts discipline: Router() + requireAuth, res.locals.userId
// per request, createServerSupabase() per request, `{ detail }` error bodies,
// try/catch → 500 `{ detail }`. Tenancy is enforced on EVERY surface — the
// store's user-facing reads/writes are id + user_id scoped, and project_id /
// chat_id links are ownership-checked before use.

import crypto from "node:crypto";
import fs from "node:fs";
import { Router } from "express";
import type { Request, Response } from "express";

import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
    checkProjectAccess,
    listAccessibleProjectIds,
    type ProjectPermission,
} from "../lib/access";
import { audioFileUpload } from "../lib/upload";
import {
    AUDIO_EXTENSIONS,
    AUDIO_MIMES,
    MAX_AUDIO_BYTES,
    extractExtension,
    isAllowedAudioExtension,
    mimeForAudioExtension,
} from "../lib/uploadTypes";
import {
    deleteFile,
    getSignedUrl,
    recordingAudioKey,
    uploadFileStream,
} from "../lib/storage";
import {
    createRecording,
    getRecordingAny,
    listRecordings,
    updateRecording,
} from "../lib/recordings/store";
import { insertRecordingCardMessage } from "../lib/recordings/postToChat";
import { RecordingArtifactError } from "../lib/recordings/artifacts";
import { generateVoiceBriefing } from "../lib/recordings/briefing";
import { generateTimelineImage } from "../lib/recordings/timelineImage";
import { draftRecordingEmail } from "../lib/recordings/emailDraft";
import type { Recording, RecordingSource } from "../lib/recordings/types";

const router = Router();
router.use(requireAuth);

async function getAuthorizedRecording(
    db: ReturnType<typeof createServerSupabase>,
    id: string,
    userId: string,
    userEmail: string | undefined,
    permission: ProjectPermission = "read",
) {
    const recording = await getRecordingAny(db, id);
    if (!recording) return null;
    if (!recording.project_id)
        return recording.user_id === userId ? recording : null;
    const access = await checkProjectAccess(
        recording.project_id,
        userId,
        userEmail,
        db,
        permission,
    );
    return access.ok ? recording : null;
}

/** Human-readable list of accepted audio extensions for 400 bodies. */
const AUDIO_EXTENSIONS_LIST = Array.from(AUDIO_EXTENSIONS).sort().join(", ");

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `value` is a well-formed UUID string. */
function isUuid(value: unknown): value is string {
    return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Conservative email-shape check — the same regex signatures.ts already uses
 * (looksLikeEmail there is a non-exported local, so its shape is replicated
 * rather than imported). Not RFC-exhaustive; a deliberate floor that rejects
 * obviously-malformed recipients before a draft is cut.
 */
function looksLikeEmail(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Validate an optional `to`/`cc` recipient field from the request body. Absent
 * (undefined/null) → `{ value: undefined }` so the draft layer applies its own
 * default. Present but not an array of email-shaped strings → `{ error }` for a
 * 400. Otherwise the trimmed addresses are returned (an empty array is allowed —
 * for `to` the draft layer falls back to the caller's address).
 */
function parseRecipientField(
    raw: unknown,
    field: "to" | "cc",
): { value: string[] | undefined } | { error: string } {
    if (raw === undefined || raw === null) return { value: undefined };
    if (!Array.isArray(raw)) {
        return { error: `${field} must be an array of email addresses.` };
    }
    const out: string[] = [];
    for (const entry of raw) {
        const trimmed = typeof entry === "string" ? entry.trim() : "";
        if (!trimmed || !looksLikeEmail(trimmed)) {
            return {
                error: `${field} must contain only valid email addresses.`,
            };
        }
        out.push(trimmed);
    }
    return { value: out };
}

/**
 * Normalize a user-supplied title: trim and cap at 200 chars. Returns undefined
 * for anything that isn't a non-empty string so the caller omits it (the DDL
 * default 'Untitled recording' then applies on insert, and PATCH leaves the
 * existing title untouched).
 */
function normalizeTitle(raw: unknown): string | undefined {
    if (typeof raw !== "string") return undefined;
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    return trimmed.slice(0, 200);
}

/**
 * Parse a multipart duration field (arrives as a string). Keeps it only when it
 * is a finite number > 0; anything else is ignored (undefined).
 */
function parseDurationSeconds(raw: unknown): number | undefined {
    const n =
        typeof raw === "number"
            ? raw
            : typeof raw === "string" && raw.trim()
              ? Number(raw)
              : NaN;
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * A download-friendly filename for the raw audio: the recording title (sanitized
 * to a safe stem) plus the stored object's extension. getSignedUrl further
 * sanitizes this for the Content-Disposition header, so this only needs to be a
 * sensible base.
 */
function audioDownloadFilename(recording: Recording): string {
    const stem =
        (recording.title || "recording")
            .replace(/[^a-zA-Z0-9 ._-]/g, "")
            .trim()
            .slice(0, 80) || "recording";
    const ext = extractExtension(recording.audio_storage_key);
    return ext ? `${stem}.${ext}` : stem;
}

// ---------------------------------------------------------------------------
// POST /recordings — enqueue one captured audio (multipart).
// ---------------------------------------------------------------------------
router.post("/", audioFileUpload("file"), async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    // Tracks the audio object we wrote so a later failure (a real insert error,
    // not just missing schema) doesn't strand bytes in storage — cleared once
    // the recording row exists and owns them. Mirrors chatAttachments.ts.
    let uploadedKey: string | null = null;
    try {
        const file = req.file;
        if (!file) {
            return void res
                .status(400)
                .json({ detail: "An audio file is required." });
        }

        // source — required "mic" | "upload".
        const source = req.body?.source;
        if (source !== "mic" && source !== "upload") {
            return void res
                .status(400)
                .json({ detail: 'source must be "mic" or "upload".' });
        }

        // consent — must be the literal string "true".
        if (req.body?.consent !== "true") {
            return void res.status(400).json({
                detail:
                    "Consent acknowledgment is required to create a recording.",
            });
        }

        // Accept the file when EITHER the filename extension is a known audio
        // type OR the browser MIME is in AUDIO_MIMES (mic captures can arrive
        // with a bare/opaque name). The stored Content-Type is still derived
        // server-side below, never trusted from the browser.
        if (
            !isAllowedAudioExtension(file.originalname) &&
            !AUDIO_MIMES.has(file.mimetype)
        ) {
            return void res.status(400).json({
                detail: `Unsupported audio type. Allowed extensions: ${AUDIO_EXTENSIONS_LIST}.`,
            });
        }

        // Size ceiling — multer's audio instance already caps at 250 MB, but keep
        // the check for defense in depth.
        if (file.size > MAX_AUDIO_BYTES) {
            return void res.status(413).json({
                detail: `Audio file too large. Maximum size is ${Math.round(
                    MAX_AUDIO_BYTES / (1024 * 1024),
                )} MB.`,
            });
        }

        // Optional title.
        const title = normalizeTitle(req.body?.title);

        // Optional project link — must belong to the caller (owner or shared
        // member), mirroring the document-upload routes' checkProjectAccess →
        // 404 convention.
        let projectId: string | undefined;
        const rawProjectId = req.body?.project_id;
        if (typeof rawProjectId === "string" && rawProjectId.trim()) {
            const candidate = rawProjectId.trim();
            if (!isUuid(candidate)) {
                return void res
                    .status(404)
                    .json({ detail: "Project not found" });
            }
            const access = await checkProjectAccess(
                candidate,
                userId,
                userEmail,
                db,
                "mutate",
            );
            if (!access.ok) {
                return void res
                    .status(404)
                    .json({ detail: "Project not found" });
            }
            projectId = candidate;
        }

        // Optional chat link — a card is posted into it below. Matter chats are
        // authorized by the already-validated project membership; standalone
        // chats remain creator-only.
        let chatId: string | undefined;
        const rawChatId = req.body?.chat_id;
        if (typeof rawChatId === "string" && rawChatId.trim()) {
            const candidate = rawChatId.trim();
            if (!isUuid(candidate)) {
                return void res.status(400).json({ detail: "Chat not found." });
            }
            const { data: chatRow, error: chatErr } = await db
                .from("chats")
                .select("id, user_id, project_id")
                .eq("id", candidate)
                .maybeSingle();
            if (chatErr) throw chatErr;
            const canLink = projectId
                ? chatRow?.project_id === projectId
                : chatRow?.project_id == null && chatRow?.user_id === userId;
            if (!chatRow || !canLink) {
                return void res.status(400).json({ detail: "Chat not found." });
            }
            chatId = candidate;
        }

        // Trust the server-derived MIME (from the audio extension) over the
        // browser-supplied file.mimetype at the storage write, per the
        // uploadTypes doc comment.
        const ext = extractExtension(file.originalname);
        const storedMime = mimeForAudioExtension(ext) ?? file.mimetype;
        const key = recordingAudioKey(userId, crypto.randomUUID(), ext);

        // The scanner-cleared temporary file remains available until the
        // response completes. Stream it so a 250 MB recording never enters the
        // Node heap as one Buffer.
        await uploadFileStream(
            key,
            fs.createReadStream(file.path),
            storedMime,
            file.size,
        );
        uploadedKey = key;

        let rec = await createRecording(db, {
            userId,
            projectId: projectId ?? null,
            chatId: chatId ?? null,
            title,
            source: source as RecordingSource,
            audioStorageKey: key,
            audioMime: storedMime,
            audioSizeBytes: file.size,
            durationSeconds: parseDurationSeconds(req.body?.duration_seconds),
            consentAckAt: new Date().toISOString(),
        });
        if (!rec) {
            // Missing schema (025 not applied) → the store degrades to null.
            // Don't strand the bytes we just wrote.
            await deleteFile(key).catch(() => {});
            uploadedKey = null;
            return void res
                .status(503)
                .json({ detail: "Recordings are not enabled." });
        }
        // The row now owns the bytes — the catch below must not delete them.
        uploadedKey = null;

        // Best-effort chat card. A card failure (deleted chat, transient error)
        // must NOT fail the recording — the row is the source of truth.
        if (chatId) {
            try {
                const messageId = await insertRecordingCardMessage(db, {
                    chatId,
                    userId,
                    recordingId: rec.id,
                    title: rec.title,
                    source: source as RecordingSource,
                });
                if (messageId) {
                    const linked = await updateRecording(db, rec.id, {
                        chat_message_id: messageId,
                    });
                    if (linked) rec = linked;
                }
            } catch (cardErr) {
                console.warn(
                    `[recordings] card post failed for recording ${rec.id}`,
                    cardErr,
                );
            }
        }

        res.status(201).json(rec);
    } catch (err) {
        if (uploadedKey) await deleteFile(uploadedKey).catch(() => {});
        res.status(500).json({
            detail:
                err instanceof Error
                    ? err.message
                    : "Failed to create recording",
        });
    }
});

// ---------------------------------------------------------------------------
// GET /recordings?project_id= — the caller's recordings, newest first.
// ---------------------------------------------------------------------------
router.get("/", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    try {
        const projectId =
            typeof req.query.project_id === "string" &&
            req.query.project_id.trim()
                ? req.query.project_id.trim()
                : undefined;
        let recordings;
        if (projectId) {
            const access = await checkProjectAccess(
                projectId,
                userId,
                userEmail,
                db,
            );
            if (!access.ok)
                return void res
                    .status(404)
                    .json({ detail: "Project not found" });
            recordings = await listRecordings(db, userId, {
                projectId,
                includeProjectMembers: true,
                limit: 100,
            });
        } else {
            const projectIds = await listAccessibleProjectIds(
                userId,
                userEmail,
                db,
            );
            const [owned, ...matterRecordings] = await Promise.all([
                listRecordings(db, userId, { limit: 100 }),
                ...projectIds.map((accessibleProjectId) =>
                    listRecordings(db, userId, {
                        projectId: accessibleProjectId,
                        includeProjectMembers: true,
                        limit: 100,
                    }),
                ),
            ]);
            const accessible = new Set(projectIds);
            const byId = new Map(
                [
                    ...owned.filter(
                        (recording) =>
                            !recording.project_id ||
                            accessible.has(recording.project_id),
                    ),
                    ...matterRecordings.flat(),
                ].map((recording) => [recording.id, recording]),
            );
            recordings = [...byId.values()]
                .sort((left, right) =>
                    right.created_at.localeCompare(left.created_at),
                )
                .slice(0, 100);
        }
        res.json({ recordings });
    } catch (err) {
        res.status(500).json({
            detail:
                err instanceof Error
                    ? err.message
                    : "Failed to load recordings",
        });
    }
});

// ---------------------------------------------------------------------------
// GET /recordings/:id — a single recording (tenancy-scoped).
// ---------------------------------------------------------------------------
router.get("/:id", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    try {
        if (!isUuid(req.params.id)) {
            return void res
                .status(404)
                .json({ detail: "Recording not found." });
        }
        const recording = await getAuthorizedRecording(
            db,
            req.params.id,
            userId,
            userEmail,
        );
        if (!recording) {
            return void res
                .status(404)
                .json({ detail: "Recording not found." });
        }
        res.json({ recording });
    } catch (err) {
        res.status(500).json({
            detail:
                err instanceof Error ? err.message : "Failed to load recording",
        });
    }
});

// ---------------------------------------------------------------------------
// GET /recordings/:id/audio — a short-lived signed URL for the raw audio.
// ---------------------------------------------------------------------------
router.get("/:id/audio", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    try {
        if (!isUuid(req.params.id)) {
            return void res
                .status(404)
                .json({ detail: "Recording not found." });
        }
        const recording = await getAuthorizedRecording(
            db,
            req.params.id,
            userId,
            userEmail,
        );
        if (!recording) {
            return void res
                .status(404)
                .json({ detail: "Recording not found." });
        }
        const url = await getSignedUrl(
            recording.audio_storage_key,
            3600,
            audioDownloadFilename(recording),
            "inline",
        );
        // getSignedUrl returns null when storage is disabled or signing fails —
        // surface it as 503, mirroring routes/documents.ts's signed-url route.
        if (!url) {
            return void res
                .status(503)
                .json({ detail: "Storage is not configured." });
        }
        res.json({ url });
    } catch (err) {
        res.status(500).json({
            detail:
                err instanceof Error
                    ? err.message
                    : "Failed to sign audio URL",
        });
    }
});

// ---------------------------------------------------------------------------
// POST /recordings/:id/voice-briefing and /:id/timeline-image — on-demand
// generators (paid model calls; chatLimiter-gated in index.ts). Both share this
// handler: validate the id, generate (or return the existing) artifact with
// `force` from the body, then reload the recording so the response carries the
// freshly-stored *_document_id. A guard failure is a typed RecordingArtifactError
// (not_found → 404, not_ready → 409); any other failure is an upstream OpenAI /
// generation failure surfaced as 502 with the adapter's detail, so an
// org-verification error (gpt-image-2) reaches the user readable.
// ---------------------------------------------------------------------------
type ArtifactGenerator = (args: {
    db: ReturnType<typeof createServerSupabase>;
    recordingId: string;
    userId: string;
    force?: boolean;
}) => Promise<{ documentId: string; created: boolean }>;

async function handleArtifactRoute(
    req: Request,
    res: Response,
    generate: ArtifactGenerator,
): Promise<void> {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    try {
        if (!isUuid(req.params.id)) {
            return void res
                .status(404)
                .json({ detail: "Recording not found." });
        }
        const authorized = await getAuthorizedRecording(
            db,
            req.params.id,
            userId,
            userEmail,
            "mutate",
        );
        if (!authorized) {
            return void res
                .status(404)
                .json({ detail: "Recording not found." });
        }
        const force = (req.body as { force?: unknown } | undefined)?.force === true;
        const result = await generate({
            db,
            recordingId: req.params.id,
            userId,
            force,
        });
        // Reload so the response reflects the stored *_document_id.
        const recording = await getAuthorizedRecording(
            db,
            req.params.id,
            userId,
            userEmail,
            "mutate",
        );
        if (!recording) {
            return void res
                .status(404)
                .json({ detail: "Recording not found." });
        }
        res.json({
            recording,
            document_id: result.documentId,
            created: result.created,
        });
    } catch (err) {
        if (err instanceof RecordingArtifactError) {
            const status = err.code === "not_found" ? 404 : 409;
            return void res.status(status).json({ detail: err.message });
        }
        // Upstream OpenAI / generation failure — surface the adapter's detail.
        res.status(502).json({
            detail:
                err instanceof Error
                    ? err.message
                    : "Failed to generate recording artifact",
        });
    }
}

router.post("/:id/voice-briefing", (req: Request, res: Response) =>
    handleArtifactRoute(req, res, generateVoiceBriefing),
);

router.post("/:id/timeline-image", (req: Request, res: Response) =>
    handleArtifactRoute(req, res, generateTimelineImage),
);

// ---------------------------------------------------------------------------
// POST /recordings/:id/email-draft — draft (never send) an email carrying the
// recording's summary + transcript PDF, through the existing agent-operation +
// pending-email rails. The draft leaves ONLY via the human-approval route the
// send_email card already uses (POST /email/:id/approve). Deterministic body
// assembly, so no chatLimiter (see index.ts). Guard failures are the shared
// RecordingArtifactError (not_found → 404, not_ready → 409); a bad recipient
// list is a 400; success returns { recording, email_id, created }.
// ---------------------------------------------------------------------------
router.post("/:id/email-draft", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    try {
        if (!isUuid(req.params.id)) {
            return void res
                .status(404)
                .json({ detail: "Recording not found." });
        }
        if (!userEmail) {
            return void res.status(400).json({
                detail: "A sender email address is required to draft an email.",
            });
        }
        const authorized = await getAuthorizedRecording(
            db,
            req.params.id,
            userId,
            userEmail,
            "mutate",
        );
        if (!authorized)
            return void res
                .status(404)
                .json({ detail: "Recording not found." });

        const body = (req.body ?? {}) as Record<string, unknown>;
        const toParsed = parseRecipientField(body.to, "to");
        if ("error" in toParsed) {
            return void res.status(400).json({ detail: toParsed.error });
        }
        const ccParsed = parseRecipientField(body.cc, "cc");
        if ("error" in ccParsed) {
            return void res.status(400).json({ detail: ccParsed.error });
        }

        const result = await draftRecordingEmail({
            db,
            recordingId: req.params.id,
            userId,
            userEmail,
            input: {
                to: toParsed.value,
                cc: ccParsed.value,
                subject:
                    typeof body.subject === "string" ? body.subject : undefined,
                note: typeof body.note === "string" ? body.note : undefined,
                // Default ON; only an explicit `false` excludes the timeline image.
                includeTimelineImage: body.include_timeline_image !== false,
                force: body.force === true,
            },
        });

        res.json({
            recording: result.recording,
            email_id: result.emailId,
            created: result.created,
        });
    } catch (err) {
        if (err instanceof RecordingArtifactError) {
            const status = err.code === "not_found" ? 404 : 409;
            return void res.status(status).json({ detail: err.message });
        }
        res.status(500).json({
            detail:
                err instanceof Error
                    ? err.message
                    : "Failed to draft recording email",
        });
    }
});

// ---------------------------------------------------------------------------
// PATCH /recordings/:id — rename and/or re-file (or unlink) the recording.
// Only `title` and `project_id` are patchable. Re-filing moves ONLY the
// recording row: artifacts already filed under a project (transcript PDF, etc.)
// intentionally stay where they were filed — re-filing them is out of scope.
// ---------------------------------------------------------------------------
router.patch("/:id", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    try {
        if (!isUuid(req.params.id)) {
            return void res
                .status(404)
                .json({ detail: "Recording not found." });
        }
        const recording = await getAuthorizedRecording(
            db,
            req.params.id,
            userId,
            userEmail,
            "mutate",
        );
        if (!recording) {
            return void res
                .status(404)
                .json({ detail: "Recording not found." });
        }

        const body = (req.body ?? {}) as Record<string, unknown>;
        const patch: { title?: string; project_id?: string | null } = {};

        if ("title" in body) {
            const title = normalizeTitle(body.title);
            if (title) patch.title = title;
        }

        if ("project_id" in body) {
            const rawProjectId = body.project_id;
            if (rawProjectId === null) {
                patch.project_id = null; // explicit unlink
            } else if (
                typeof rawProjectId === "string" &&
                rawProjectId.trim()
            ) {
                const candidate = rawProjectId.trim();
                if (!isUuid(candidate)) {
                    return void res
                        .status(404)
                        .json({ detail: "Project not found" });
                }
                const access = await checkProjectAccess(
                    candidate,
                    userId,
                    userEmail,
                    db,
                    "mutate",
                );
                if (!access.ok) {
                    return void res
                        .status(404)
                        .json({ detail: "Project not found" });
                }
                patch.project_id = candidate;
            }
        }

        if (Object.keys(patch).length === 0) {
            return void res.json({ recording });
        }
        const updated = await updateRecording(db, recording.id, patch);
        res.json({ recording: updated ?? recording });
    } catch (err) {
        res.status(500).json({
            detail:
                err instanceof Error
                    ? err.message
                    : "Failed to update recording",
        });
    }
});

// ---------------------------------------------------------------------------
// POST /recordings/:id/action-items/:itemId/toggle — flip one item's `done`.
// ---------------------------------------------------------------------------
router.post(
    "/:id/action-items/:itemId/toggle",
    async (req: Request, res: Response) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const db = createServerSupabase();
        try {
            if (!isUuid(req.params.id)) {
                return void res
                    .status(404)
                    .json({ detail: "Recording not found." });
            }
            const recording = await getAuthorizedRecording(
                db,
                req.params.id,
                userId,
                userEmail,
                "mutate",
            );
            if (!recording) {
                return void res
                    .status(404)
                    .json({ detail: "Recording not found." });
            }
            const items = recording.action_items;
            const idx = items.findIndex((it) => it.id === req.params.itemId);
            if (idx === -1) {
                return void res
                    .status(404)
                    .json({ detail: "Action item not found." });
            }
            const nextItems = items.map((it, i) =>
                i === idx ? { ...it, done: !it.done } : it,
            );
            const updated = await updateRecording(db, recording.id, {
                action_items: nextItems,
            });
            res.json({
                recording:
                    updated ?? { ...recording, action_items: nextItems },
            });
        } catch (err) {
            res.status(500).json({
                detail:
                    err instanceof Error
                        ? err.message
                        : "Failed to toggle action item",
            });
        }
    },
);

// ---------------------------------------------------------------------------
// DELETE /recordings/:id — remove the recording, its raw audio, and every
// generated artifact document. An explicit user delete removes the raw audio
// too (the keep-forever retention governs only the automatic lifecycle).
// ---------------------------------------------------------------------------
router.delete("/:id", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    try {
        if (!isUuid(req.params.id)) {
            return void res
                .status(404)
                .json({ detail: "Recording not found." });
        }
        const recording = await getAuthorizedRecording(
            db,
            req.params.id,
            userId,
            userEmail,
            "lifecycle",
        );
        if (!recording) {
            return void res
                .status(404)
                .json({ detail: "Recording not found." });
        }

        // Raw audio — best-effort (a missing object must not block the delete).
        await deleteFile(recording.audio_storage_key).catch(() => {});

        // Generated artifact documents (transcript PDF / voice briefing / timeline
        // image). No shared/exported document-deletion helper exists — the only
        // precedent is the inline handler in routes/documents.ts (DELETE
        // /:documentId), which fans out over the document's versions to delete
        // their storage bytes, then drops the documents row (document_versions
        // rows cascade away via the FK). This mirrors that pattern; the explicit
        // document_versions delete is a belt-and-suspenders companion to that
        // ON DELETE CASCADE. Flagged in the task report.
        const artifactDocIds = [
            recording.transcript_document_id,
            recording.voice_briefing_document_id,
            recording.timeline_image_document_id,
        ].filter((v): v is string => typeof v === "string" && v.length > 0);

        if (artifactDocIds.length > 0) {
            const { data: versions } = await db
                .from("document_versions")
                .select("storage_path, pdf_storage_path")
                .in("document_id", artifactDocIds);
            await Promise.all(
                (
                    (versions ?? []) as {
                        storage_path: string | null;
                        pdf_storage_path: string | null;
                    }[]
                ).flatMap((v) =>
                    [v.storage_path, v.pdf_storage_path]
                        .filter(
                            (p): p is string =>
                                typeof p === "string" && p.length > 0,
                        )
                        .map((p) => deleteFile(p).catch(() => {})),
                ),
            );
            await db
                .from("document_versions")
                .delete()
                .in("document_id", artifactDocIds);
            await db.from("documents").delete().in("id", artifactDocIds);
        }

        // Finally the recording row itself (tenancy-scoped).
        await db
            .from("recordings")
            .delete()
            .eq("id", recording.id)
            .eq("user_id", userId);

        res.status(204).send();
    } catch (err) {
        res.status(500).json({
            detail:
                err instanceof Error
                    ? err.message
                    : "Failed to delete recording",
        });
    }
});

export { router as recordingsRouter };
