import type { ChatMessage } from "./chatTools";

// Shared request validation for the two chat entry points (POST /chat and
// POST /projects/:projectId/chat). Lives in lib because routes must not
// import from each other — projectChat originally blind-cast req.body and a
// malformed `messages` field crashed the process before any auth-adjacent
// code could reject it.
export function parseChatMessages(
    value: unknown,
): { ok: true; messages: ChatMessage[] } | { ok: false; detail: string } {
    if (!Array.isArray(value) || value.length === 0) {
        return { ok: false, detail: "messages must be a non-empty array" };
    }

    for (const message of value) {
        if (!message || typeof message !== "object" || Array.isArray(message)) {
            return { ok: false, detail: "messages must contain objects" };
        }
        const row = message as Record<string, unknown>;
        if (typeof row.role !== "string") {
            return { ok: false, detail: "message.role must be a string" };
        }
        if (row.content !== null && typeof row.content !== "string") {
            return {
                ok: false,
                detail: "message.content must be a string or null",
            };
        }
    }

    return { ok: true, messages: value as ChatMessage[] };
}

/**
 * Parse one current user turn. New clients send `message`; legacy clients may
 * still send `messages` for one compatibility release, but only the newest
 * user entry is accepted from that array. Historical browser entries are
 * intentionally discarded because saved database rows are authoritative.
 */
export function parseCurrentChatMessage(
    messageValue: unknown,
    legacyMessagesValue: unknown,
):
    | { ok: true; message: ChatMessage; usedLegacyPayload: boolean }
    | { ok: false; detail: string } {
    if (messageValue !== undefined) {
        if (
            !messageValue ||
            typeof messageValue !== "object" ||
            Array.isArray(messageValue)
        ) {
            return { ok: false, detail: "message must be an object" };
        }
        const row = messageValue as Record<string, unknown>;
        if (typeof row.content !== "string" || !row.content.trim()) {
            return {
                ok: false,
                detail: "message.content must be a non-empty string",
            };
        }
        if (row.files !== undefined && !Array.isArray(row.files)) {
            return { ok: false, detail: "message.files must be an array" };
        }
        if (
            row.workflow !== undefined &&
            row.workflow !== null &&
            (typeof row.workflow !== "object" || Array.isArray(row.workflow))
        ) {
            return { ok: false, detail: "message.workflow must be an object" };
        }
        return {
            ok: true,
            usedLegacyPayload: false,
            message: {
                role: "user",
                content: row.content,
                files: row.files as ChatMessage["files"],
                workflow: row.workflow as ChatMessage["workflow"],
            },
        };
    }

    const legacy = parseChatMessages(legacyMessagesValue);
    if (!legacy.ok) return legacy;
    const latestUser = [...legacy.messages]
        .reverse()
        .find(
            (message) =>
                message.role === "user" &&
                typeof message.content === "string" &&
                message.content.trim(),
        );
    if (!latestUser) {
        return {
            ok: false,
            detail: "messages must include a non-empty user message",
        };
    }
    return {
        ok: true,
        usedLegacyPayload: true,
        message: { ...latestUser, role: "user" },
    };
}

/**
 * Parse the optional `edit_image_source` request field — the source image bound
 * by the frontend "Edit" button for an image-to-image edit. Returns null unless
 * it carries a non-empty document_id or attachment_id. Shared by both chat
 * entry points so the "Edit" affordance works in main and matter chats alike.
 */
export function parseEditImageSource(
    value: unknown,
): { document_id: string | null; attachment_id: string | null } | null {
    if (!value || typeof value !== "object") return null;
    const s = value as { document_id?: unknown; attachment_id?: unknown };
    const documentId =
        typeof s.document_id === "string" && s.document_id.trim()
            ? s.document_id.trim()
            : null;
    const attachmentId =
        typeof s.attachment_id === "string" && s.attachment_id.trim()
            ? s.attachment_id.trim()
            : null;
    return documentId || attachmentId
        ? { document_id: documentId, attachment_id: attachmentId }
        : null;
}

/**
 * A confirmed in-chat capability run, as posted alongside the user's turn.
 * `capabilityId` is a registry id the route still has to resolve — parsing
 * only proves the SHAPE is sane, never that the capability exists or can run
 * in chat (the route answers that with a 400).
 */
export interface CapabilityRunRequest {
    capabilityId: string;
    proposalId: string | null;
    documentIds: string[];
    inputs: { representedParty: string | null };
}

/** Registry ids are kebab-case, letter-led, 3-64 chars. */
const CAPABILITY_ID_RE = /^[a-z][a-z0-9-]{2,63}$/;
const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** At most this many focus documents may be pinned to one run. */
const MAX_RUN_DOCUMENT_IDS = 10;

/**
 * The only sides a run may be anchored to — the same closed vocabulary the
 * composer chip offers.
 *
 * This is not a length bound but a whitelist, because the value is
 * substituted VERBATIM into the run system prompt via `String.replace`,
 * where `$&`, `$'` and friends are replacement patterns rather than literal
 * text. Refusing anything outside the vocabulary neutralizes that at the
 * input boundary and keeps a free-text instruction out of the prompt.
 */
const REPRESENTED_PARTY_VALUES = [
    "vendor",
    "customer",
    "licensor",
    "licensee",
    "partner",
    "other",
] as const;

/**
 * Parse the optional `capability_run` request field — the record the composer
 * chip posts when the user confirms "Run <capability>" and the run happens in
 * THIS chat rather than a modal.
 *
 * Everything here is attacker-reachable browser input that ends up in a system
 * prompt, so the posture is: bound every field, drop junk inside a field
 * rather than trust it, and return null (→ an ordinary chat turn, no run) for
 * anything whose envelope is not recognisable. Never throws.
 */
export function parseCapabilityRun(
    value: unknown,
): CapabilityRunRequest | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    const row = value as {
        capability_id?: unknown;
        proposal_id?: unknown;
        document_ids?: unknown;
        inputs?: unknown;
    };

    if (
        typeof row.capability_id !== "string" ||
        !CAPABILITY_ID_RE.test(row.capability_id)
    ) {
        return null;
    }

    const proposalId =
        typeof row.proposal_id === "string" && UUID_RE.test(row.proposal_id)
            ? row.proposal_id
            : null;

    const documentIds: string[] = [];
    if (Array.isArray(row.document_ids)) {
        for (const entry of row.document_ids) {
            if (documentIds.length >= MAX_RUN_DOCUMENT_IDS) break;
            if (typeof entry !== "string") continue;
            const trimmed = entry.trim();
            // Focus document ids are matched against this turn's doc handles,
            // which are always UUIDs; anything else is junk that would only
            // reach a jsonb column and a retry payload.
            if (!UUID_RE.test(trimmed)) continue;
            if (documentIds.includes(trimmed)) continue;
            documentIds.push(trimmed);
        }
    }

    let representedParty: string | null = null;
    if (row.inputs && typeof row.inputs === "object") {
        const raw = (row.inputs as { represented_party?: unknown })
            .represented_party;
        if (typeof raw === "string") {
            const candidate = raw.trim().toLowerCase();
            if (
                (REPRESENTED_PARTY_VALUES as readonly string[]).includes(
                    candidate,
                )
            ) {
                representedParty = candidate;
            }
        }
    }

    return {
        capabilityId: row.capability_id,
        proposalId,
        documentIds,
        inputs: { representedParty },
    };
}
