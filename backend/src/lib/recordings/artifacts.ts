// backend/src/lib/recordings/artifacts.ts
//
// Shared machinery for the recordings' on-demand generated artifacts (the
// transcript PDF, the voice-briefing MP3, and the timeline PNG). Three pieces
// the three generators would otherwise duplicate:
//
//   * RecordingArtifactError — the typed domain error the on-demand generators
//     throw for the two user-facing guard failures (not-found / not-ready), which
//     routes map to 404 / 409 (mirror of connectors/types.ts's
//     ConnectorNotConfiguredError + pi/csvImport.ts's ImportTooLargeError, which
//     routes already dispatch on via `instanceof`).
//   * loadReadyRecording — the tenancy-scoped read + readiness guard both the
//     briefing and timeline generators run before doing any paid work.
//   * persistGeneratedArtifact — the documents + document_versions persistence
//     sequence, lifted VERBATIM from persistTranscriptPdf (which mirrored
//     persistAuthoredDocx) and parameterized on filename label / extension /
//     file_type / content-type / bytes / derivation kind. The `documents` schema
//     is free-text `file_type` (schema.sql: no CHECK) and a nullable
//     `pdf_storage_path` on the version, so an MP3/PNG needs NO pdf-specific
//     fields — exactly the transcript-PDF shape with a different file_type/mime.
//
// A failure THROWS (callers own retry/surfacing), matching persistTranscriptPdf.

import type { createServerSupabase } from "../supabase";
import {
    persistGeneratedDocument,
    type PersistGeneratedDocumentDeps,
} from "../documents/persistGeneratedDocument";
import { getRecording } from "./store";
import type { Recording } from "./types";

type Db = ReturnType<typeof createServerSupabase>;

/** Why an on-demand artifact request could not proceed, for the route to map. */
export type RecordingArtifactErrorCode = "not_found" | "not_ready";

/**
 * A user-facing guard failure from an on-demand artifact generator. `code`
 * drives the HTTP status the route returns (not_found → 404, not_ready → 409);
 * upstream OpenAI failures are NOT this — they propagate as their adapter Error
 * and the route maps them to 502.
 */
export class RecordingArtifactError extends Error {
    readonly code: RecordingArtifactErrorCode;
    constructor(code: RecordingArtifactErrorCode, message: string) {
        super(message);
        this.name = "RecordingArtifactError";
        this.code = code;
    }
}

/**
 * Tenancy-scoped read + readiness guard shared by the on-demand generators.
 * Throws RecordingArtifactError("not_found") when the id isn't the caller's, and
 * ("not_ready") until the pipeline has driven it to `ready` WITH a summary (the
 * summary is the factual source both generators feed their prompt). Returns the
 * ready recording otherwise. `getRecordingFn` is injectable for tests.
 */
export async function loadReadyRecording(params: {
    db: Db;
    recordingId: string;
    userId: string;
    getRecordingFn?: typeof getRecording;
}): Promise<Recording> {
    const get = params.getRecordingFn ?? getRecording;
    const recording = await get(params.db, params.recordingId, params.userId);
    if (!recording) {
        throw new RecordingArtifactError("not_found", "Recording not found.");
    }
    if (recording.status !== "ready" || !recording.summary_md?.trim()) {
        throw new RecordingArtifactError(
            "not_ready",
            "Recording is not ready yet.",
        );
    }
    return recording;
}

export interface PersistArtifactDeps extends PersistGeneratedDocumentDeps {}

/**
 * Persist `bytes` as a first-class documents + document_versions row owned by
 * the recording's user, attached to its project when it has one (null →
 * standalone), so the artifact inherits the download + email-attachment rails.
 * A thin recording-shaped adapter over the generic persistGeneratedDocument
 * (which owns the insert sequence): it maps the recording's user/project/title
 * and stamps `recording_id` provenance. Any failure THROWS. Returns the new ids.
 */
export async function persistGeneratedArtifact(params: {
    db: Db;
    recording: Recording;
    bytes: Buffer;
    /** Known source text that must survive PDF generation (never persisted). */
    expectedText?: string;
    /** Filename suffix after " - " and the sanitized-empty fallback stem. */
    label: string;
    /** File extension without a dot: "pdf" | "mp3" | "png". */
    extension: string;
    /** documents.file_type (free text; e.g. "pdf" | "mp3" | "png"). */
    fileType: string;
    /** Upload content-type (e.g. "application/pdf" | "audio/mpeg" | "image/png"). */
    contentType: string;
    /** document_versions.metadata.derivation_kind provenance tag. */
    derivationKind: string;
    deps?: Partial<PersistArtifactDeps>;
}): Promise<{ documentId: string; versionId: string }> {
    const { recording } = params;
    const { documentId, versionId } = await persistGeneratedDocument({
        db: params.db,
        userId: recording.user_id,
        projectId: recording.project_id ?? null,
        title: recording.title?.trim() || "Recording",
        label: params.label,
        extension: params.extension,
        fileType: params.fileType,
        contentType: params.contentType,
        bytes: params.bytes,
        expectedText: params.expectedText,
        derivationKind: params.derivationKind,
        extraMetadata: { recording_id: recording.id },
        deps: params.deps,
    });
    return { documentId, versionId };
}
