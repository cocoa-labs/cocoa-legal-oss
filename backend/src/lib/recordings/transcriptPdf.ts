// backend/src/lib/recordings/transcriptPdf.ts
//
// Renders a recording's transcript to Markdown and persists it as a first-class
// PDF `documents` + `document_versions` row, so the transcript inherits the
// download + email-attachment rails (see migrations/025_recordings.sql). The
// persistence sequence lives in artifacts.ts's persistGeneratedArtifact (a
// verbatim lift of what this module used to inline, itself a mirror of
// persistAuthoredDocx); this module now only owns the transcript-specific parts:
// building the Markdown and rendering it to PDF bytes before handing off.
//
// NOTE (divergences from the Task-4 brief, following the codebase — see the
// task report): the `documents` table has NO `title`/`source`/`content_status`
// columns — the title maps to `filename` (+ the version's `display_name`), and
// `source` lives on the VERSION row, not the document. Unlike persistAuthoredDocx
// (which swallows failures to `{ error }`), this THROWS on any failure — the
// brief specifies errors propagate so the pipeline's retry backoff owns them.

import type { createServerSupabase } from "../supabase";
import { convertToPdf } from "../convert";
import { verifyDerivedArtifact } from "../documentLayoutGate";
import { uploadFile } from "../storage";
import { persistGeneratedArtifact } from "./artifacts";
import type { Recording, Utterance } from "./types";

type Db = ReturnType<typeof createServerSupabase>;

function pad2(n: number): string {
    return String(n).padStart(2, "0");
}

/** Whole seconds → `m:ss` (seconds zero-padded; minutes may exceed 59 for a
 * long recording, so they are intentionally uncapped). Used for both the total
 * duration and per-utterance timestamps. */
export function formatClock(totalSeconds: number): string {
    const s = Math.max(0, Math.floor(totalSeconds));
    return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}

/** ISO timestamp → `YYYY-MM-DD`; an unparseable value is passed through as-is. */
function formatDate(createdAt: string): string {
    const d = new Date(createdAt);
    return Number.isNaN(d.getTime()) ? createdAt : d.toISOString().slice(0, 10);
}

/**
 * Pure: render a transcript to Markdown for the PDF path. Nothing is escaped
 * here on purpose — the output goes through convertToPdf("md"), which renders
 * via marked and then sanitize-html before LibreOffice ever sees it.
 */
export function buildTranscriptMarkdown(input: {
    title: string;
    createdAt: string;
    durationSeconds: number | null;
    utterances: Utterance[];
    transcriptText: string | null;
}): string {
    const title = input.title?.trim() || "Recording";
    const lines: string[] = [`# ${title}`, ""];

    const metaParts: string[] = [formatDate(input.createdAt)];
    if (
        input.durationSeconds != null &&
        Number.isFinite(input.durationSeconds)
    ) {
        metaParts.push(formatClock(input.durationSeconds));
    }
    if (input.utterances.length > 0) {
        const speakers = new Set(input.utterances.map((u) => u.speaker)).size;
        metaParts.push(`${speakers} speaker${speakers === 1 ? "" : "s"}`);
    }
    lines.push(metaParts.join(" · "), "");

    if (input.utterances.length > 0) {
        for (const u of input.utterances) {
            // `speaker` already reads "Speaker A" (assemblyai.ts prepends it);
            // used verbatim, never re-prefixed.
            const speaker = u.speaker?.trim() || "Speaker";
            lines.push(
                `**${speaker}** [${formatClock(u.start_ms / 1000)}]:`,
                u.text,
                "",
            );
        }
    } else {
        const body = (input.transcriptText ?? "").trim();
        lines.push(body || "_No transcript available._", "");
    }

    return lines.join("\n").trimEnd() + "\n";
}

export interface PersistTranscriptDeps {
    convertToPdf: typeof convertToPdf;
    uploadFile: typeof uploadFile;
    verifyDerivedArtifact: typeof verifyDerivedArtifact;
    now: () => string;
}

const DEFAULT_DEPS: PersistTranscriptDeps = {
    convertToPdf,
    uploadFile,
    verifyDerivedArtifact,
    now: () => new Date().toISOString(),
};

/**
 * Build the transcript PDF and persist it as a documents + document_versions
 * row owned by the recording's user, attached to its project when it has one
 * (null → standalone). Deps are injectable for tests; production omits them.
 * Returns the new ids; any failure THROWS (the pipeline owns retry).
 */
export async function persistTranscriptPdf(params: {
    db: Db;
    recording: Recording;
    deps?: Partial<PersistTranscriptDeps>;
}): Promise<{ documentId: string; versionId: string }> {
    const deps = { ...DEFAULT_DEPS, ...params.deps };
    const { db, recording } = params;

    const md = buildTranscriptMarkdown({
        title: recording.title,
        createdAt: recording.created_at || deps.now(),
        durationSeconds: recording.duration_seconds,
        utterances: recording.utterances,
        transcriptText: recording.transcript_text,
    });

    const pdf = await deps.convertToPdf(Buffer.from(md, "utf-8"), "md");

    // Hand the rendered PDF bytes to the shared persist sequence. The " - transcript"
    // label is joined with an ASCII hyphen so it survives the [a-zA-Z0-9 -]
    // filename filter; file_type "pdf" + the application/pdf content type are the
    // transcript specifics (see persistGeneratedArtifact).
    return persistGeneratedArtifact({
        db,
        recording,
        bytes: pdf,
        expectedText: md.replace(/[*_#`>]/g, " "),
        label: "transcript",
        extension: "pdf",
        fileType: "pdf",
        contentType: "application/pdf",
        derivationKind: "recording_transcript",
        deps: {
            uploadFile: deps.uploadFile,
            verifyDerivedArtifact: deps.verifyDerivedArtifact,
        },
    });
}
