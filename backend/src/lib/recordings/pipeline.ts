// backend/src/lib/recordings/pipeline.ts
//
// The recordings pipeline: a captured audio's `recordings` row walks
// queued → transcribing → summarizing → ready, with a `failed` exit and
// next_attempt_at backoff. This is the orchestrator the scheduler (T6) drives;
// it mirrors lib/automation/pipeline.ts's disciplines, adapted to the recordings
// store's own claim/retry shape. HARD BOUNDARIES this module owns:
//
//   - Every status transition is a claimRecordingStep CAS, so a stall-sweeper
//     (markStalledRecordingsQueued) or a competing worker interleaving costs us
//     the recording, never a double-process. A lost claim returns quietly.
//   - The single LLM call happens ONLY via generateRecordingSummary (tool-free
//     completeStructured by construction); the transcript is framed as untrusted
//     data there. The model id is ALWAYS recordingsModel(env) — never hardcoded.
//   - Failures are loud but contained: a thrown step (or a documented soft
//     failure like a malformed empty transcript id, or AssemblyAI's own error
//     status) hands off to the store's scheduleRetry, which pushes a backoff and
//     converts persistent failures to `failed` at the retry cap. A chat that was
//     deleted between capture and ready never fails an otherwise-ready recording.
//   - Recordings are processed SERIALLY (processDueRecordings awaits each
//     processRecording), matching the store's single-worker-per-row assumption.
//
// Key/model resolution MIRRORS automation/pipeline.ts exactly: the worker holds
// no request context, so it resolves the recording OWNER's BYOK keys server-side
// the same way automation resolves the email owner's — getUserApiKeys(userId,
// db), best-effort (a lookup failure degrades to no BYOK, i.e. {}), and the
// model via recordingsModel(env). See automation/pipeline.ts lines 531
// (getUserApiKeysFn default), 588–592 (best-effort try/catch), 551 (modelFn
// default) — replicated below.
//
// Every collaborator is injectable (ProcessRecordingDeps) so the state-machine
// logic is tested without a database, a network, or a model.

import type { createServerSupabase } from "../supabase";
import { getSignedUrl } from "../storage";
import { getUserApiKeys } from "../userSettings";
import type { UserApiKeys } from "../llm/types";
import {
    assemblyAiApiKey,
    recordingsMaxRetries,
    recordingsModel,
} from "./env";
import {
    getTranscription,
    submitTranscription,
} from "./assemblyai";
import { generateRecordingSummary } from "./summarize";
import { persistTranscriptPdf } from "./transcriptPdf";
import { insertRecordingSummaryMessage } from "./postToChat";
import {
    backoffDelayMs,
    claimRecordingStep,
    getRecordingAny,
    listDueRecordings,
    scheduleRetry,
    updateRecording,
    type RecordingPatch,
} from "./store";
import type { Recording } from "./types";

type Db = ReturnType<typeof createServerSupabase>;

export type Step = "submit" | "poll" | "summarize" | "done";

/** Fixed poll cadence: re-check an in-flight AssemblyAI job every 10s. */
export const POLL_DELAY_MS = 10_000;

/** Signed-audio-URL TTL handed to AssemblyAI (seconds) — 2 hours. */
export const SIGN_URL_TTL_SECONDS = 7200;

/** Heartbeat cadence during the slow summarize step (updated_at = stall detector). */
export const HEARTBEAT_INTERVAL_MS = 60_000;

/** The DDL default title (migration 025); only a still-default title is
 * overwritten by the generated summary title. */
const DEFAULT_RECORDING_TITLE = "Untitled recording";

/** Non-empty string guard: an empty string counts as ABSENT (a documented
 * malformed-2xx from AssemblyAI can yield id:"" — it must never be polled). */
function present(value: string | null | undefined): value is string {
    return typeof value === "string" && value.length > 0;
}

/**
 * Pure step decision from a recording's PERSISTED fields, so re-entry (a
 * stall-recovered row the sweep put back to `queued`) resumes exactly where the
 * previous worker stopped:
 *   - ready / failed        → done
 *   - transcript present    → summarize (whatever the working status — even
 *     when summary_md is ALSO present: a crash between the summary write and
 *     the ready CAS resumes here, and the summarize step itself skips the
 *     LLM/PDF sub-steps that are already persisted, so this can never cost a
 *     re-transcription or a re-bill)
 *   - assemblyai id present → poll
 *   - otherwise             → submit
 */
export function nextStep(
    recording: Pick<
        Recording,
        "status" | "assemblyai_transcript_id" | "transcript_text"
    >,
): Step {
    if (recording.status === "ready" || recording.status === "failed") {
        return "done";
    }
    if (present(recording.transcript_text)) {
        return "summarize";
    }
    if (present(recording.assemblyai_transcript_id)) {
        return "poll";
    }
    return "submit";
}

/**
 * Run `fn` with a periodic updated_at heartbeat on the recording row, so the
 * stall sweeper never mistakes a slow summarize (LLM + LibreOffice PDF render)
 * for a dead worker. Faithful replica of automation/pipeline.ts's withHeartbeat
 * (lines 135–153): the interval is .unref()'d and ALWAYS cleared; a missed beat
 * is swallowed (recoverable), a crashed step is not worth causing.
 */
export async function withHeartbeat<T>(
    opts: {
        db: Db;
        recordingId: string;
        intervalMs: number;
        updateRecordingFn: typeof updateRecording;
    },
    fn: () => Promise<T>,
): Promise<T> {
    const timer = setInterval(() => {
        void opts
            .updateRecordingFn(opts.db, opts.recordingId, {})
            .catch(() => {});
    }, opts.intervalMs);
    timer.unref?.();
    try {
        return await fn();
    } finally {
        clearInterval(timer);
    }
}

export type ProcessRecordingOutcome =
    | "missing"
    | "done"
    | "lost-claim"
    | "submitted"
    | "polling"
    | "ready"
    | "retry-scheduled"
    | "failed";

/** Injectable collaborators; every default is the real implementation. */
export interface ProcessRecordingDeps {
    getRecordingAnyFn?: typeof getRecordingAny;
    claimRecordingStepFn?: typeof claimRecordingStep;
    updateRecordingFn?: typeof updateRecording;
    scheduleRetryFn?: typeof scheduleRetry;
    submitTranscriptionFn?: typeof submitTranscription;
    getTranscriptionFn?: typeof getTranscription;
    /** Sign the audio object for AssemblyAI. Default wraps getSignedUrl(key,
     * 7200, undefined, "inline"). */
    signAudioUrlFn?: (storageKey: string) => Promise<string | null>;
    generateRecordingSummaryFn?: typeof generateRecordingSummary;
    persistTranscriptPdfFn?: typeof persistTranscriptPdf;
    insertRecordingSummaryMessageFn?: typeof insertRecordingSummaryMessage;
    /** Owner BYOK key resolution — mirrors automation's getUserApiKeysFn. */
    getUserApiKeysFn?: (userId: string, db: Db) => Promise<UserApiKeys>;
    assemblyAiApiKeyFn?: typeof assemblyAiApiKey;
    modelFn?: typeof recordingsModel;
    maxRetriesFn?: typeof recordingsMaxRetries;
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    heartbeatIntervalMs?: number;
}

/** Deps after defaulting, with env pre-bound into the reader collaborators so
 * the step functions don't thread env around. */
interface ResolvedDeps {
    db: Db;
    getRecordingAny: typeof getRecordingAny;
    claim: typeof claimRecordingStep;
    update: typeof updateRecording;
    scheduleRetry: typeof scheduleRetry;
    submit: typeof submitTranscription;
    getTranscription: typeof getTranscription;
    signAudioUrl: (storageKey: string) => Promise<string | null>;
    generateSummary: typeof generateRecordingSummary;
    persistPdf: typeof persistTranscriptPdf;
    insertSummaryMessage: typeof insertRecordingSummaryMessage;
    getUserApiKeys: (userId: string, db: Db) => Promise<UserApiKeys>;
    /** Pre-bound to env — the server-only AssemblyAI key. */
    assemblyKey: () => string | null;
    /** Pre-bound to env — recordingsModel(env). */
    model: () => string;
    /** Pre-bound to env — recordingsMaxRetries(env). */
    maxRetries: () => number;
    now: () => number;
    heartbeatIntervalMs: number;
}

function resolveDeps(db: Db, deps: ProcessRecordingDeps): ResolvedDeps {
    const env = deps.env ?? process.env;
    return {
        db,
        getRecordingAny: deps.getRecordingAnyFn ?? getRecordingAny,
        claim: deps.claimRecordingStepFn ?? claimRecordingStep,
        update: deps.updateRecordingFn ?? updateRecording,
        scheduleRetry: deps.scheduleRetryFn ?? scheduleRetry,
        submit: deps.submitTranscriptionFn ?? submitTranscription,
        getTranscription: deps.getTranscriptionFn ?? getTranscription,
        signAudioUrl:
            deps.signAudioUrlFn ??
            ((key: string) =>
                getSignedUrl(key, SIGN_URL_TTL_SECONDS, undefined, "inline")),
        generateSummary:
            deps.generateRecordingSummaryFn ?? generateRecordingSummary,
        persistPdf: deps.persistTranscriptPdfFn ?? persistTranscriptPdf,
        insertSummaryMessage:
            deps.insertRecordingSummaryMessageFn ?? insertRecordingSummaryMessage,
        getUserApiKeys: deps.getUserApiKeysFn ?? getUserApiKeys,
        assemblyKey: () => (deps.assemblyAiApiKeyFn ?? assemblyAiApiKey)(env),
        model: () => (deps.modelFn ?? recordingsModel)(env),
        maxRetries: () => (deps.maxRetriesFn ?? recordingsMaxRetries)(env),
        now: deps.now ?? Date.now,
        heartbeatIntervalMs: deps.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
    };
}

/**
 * Hand a step failure to the store's scheduleRetry (backoff from the row's
 * current retry_count; the store pushes next_attempt_at and converts persistent
 * failures to `failed` at maxRetries). Returns the outcome to report.
 */
async function retryOutcome(
    r: ResolvedDeps,
    id: string,
    error: string,
    retryCount: number,
): Promise<ProcessRecordingOutcome> {
    const row = await r.scheduleRetry(r.db, id, {
        error,
        delayMs: backoffDelayMs(retryCount),
        maxRetries: r.maxRetries(),
    });
    return row?.status === "failed" ? "failed" : "retry-scheduled";
}

/**
 * submit: claim the row's ACTUAL current status → transcribing (a fresh or
 * stall-recovered row claims queued→transcribing), sign the audio, kick off a
 * diarized transcription. A malformed empty id is a soft failure → scheduleRetry
 * (NEVER store an empty id). Otherwise store the id and schedule the first poll.
 */
async function runSubmitStep(
    r: ResolvedDeps,
    recording: Recording,
): Promise<{ outcome: ProcessRecordingOutcome }> {
    const claimed = await r.claim(
        r.db,
        recording.id,
        recording.status,
        "transcribing",
    );
    if (!claimed) return { outcome: "lost-claim" };

    const audioUrl = await r.signAudioUrl(claimed.audio_storage_key);
    if (!audioUrl) {
        throw new Error(
            `Could not sign audio URL for recording ${claimed.id}`,
        );
    }

    const submitResult = await r.submit({
        audioUrl,
        apiKey: r.assemblyKey(),
    });
    if (!present(submitResult.id)) {
        return {
            outcome: await retryOutcome(
                r,
                claimed.id,
                "AssemblyAI returned no transcript id",
                claimed.retry_count,
            ),
        };
    }

    await r.update(r.db, claimed.id, {
        assemblyai_transcript_id: submitResult.id,
        next_attempt_at: new Date(r.now() + POLL_DELAY_MS).toISOString(),
    });
    return { outcome: "submitted" };
}

type PollResult =
    | { kind: "terminal"; outcome: ProcessRecordingOutcome }
    | { kind: "fallthrough"; recording: Recording };

/**
 * poll: read the AssemblyAI job back.
 *   - queued/processing → push next_attempt_at +10s (also a heartbeat) and wait
 *   - error             → scheduleRetry with AssemblyAI's own message
 *   - completed         → store utterances + transcript_text (+ duration_seconds
 *     only when the row has none), CAS current→summarizing (from the row's
 *     ACTUAL status — a stall-recovered row polls while sitting in `queued`),
 *     and fall through to summarize IN THE SAME invocation (no extra wait).
 */
async function runPollStep(
    r: ResolvedDeps,
    recording: Recording,
): Promise<PollResult> {
    const transcript = await r.getTranscription({
        transcriptId: recording.assemblyai_transcript_id ?? "",
        apiKey: r.assemblyKey(),
    });

    if (transcript.status === "queued" || transcript.status === "processing") {
        await r.update(r.db, recording.id, {
            next_attempt_at: new Date(r.now() + POLL_DELAY_MS).toISOString(),
        });
        return { kind: "terminal", outcome: "polling" };
    }

    if (transcript.status === "error") {
        return {
            kind: "terminal",
            outcome: await retryOutcome(
                r,
                recording.id,
                transcript.error ?? "AssemblyAI transcription failed",
                recording.retry_count,
            ),
        };
    }

    // completed
    const patch: RecordingPatch = {
        utterances: transcript.utterances,
        transcript_text: transcript.text ?? "",
    };
    if (
        recording.duration_seconds == null &&
        transcript.audio_duration_seconds != null
    ) {
        patch.duration_seconds = transcript.audio_duration_seconds;
    }
    await r.update(r.db, recording.id, patch);

    // Claim from the row's ACTUAL current status: a stall-recovered row polls
    // to completed while sitting in `queued`, not `transcribing` — a hardcoded
    // from-status would doom the claim and waste a tick.
    const claimed = await r.claim(
        r.db,
        recording.id,
        recording.status,
        "summarizing",
    );
    if (!claimed) return { kind: "terminal", outcome: "lost-claim" };
    return { kind: "fallthrough", recording: claimed };
}

/**
 * summarize (the row is already claimed to `summarizing`). Wrapped in
 * withHeartbeat because the LLM + PDF render are slow. IDEMPOTENT for resume —
 * each sub-step is skipped when its output is already persisted, so a
 * crash-window row (summary written, ready CAS never happened) resumes cheaply:
 * no AssemblyAI resubmit, no LLM re-bill, no duplicate PDF document.
 *   - summary_md absent → resolve the owner's keys (best-effort → {}) + model →
 *     generateRecordingSummary → store summary_md / action_items / title
 *     (title ONLY when still the default; the title update is skipped together
 *     with the LLM call);
 *   - transcript_document_id absent → persistTranscriptPdf → store it;
 *   - always: CAS summarizing→ready → best-effort chat post (a deleted chat
 *     never fails an otherwise-ready recording; the post sits AFTER the ready
 *     CAS, so a resumed row can never double-post).
 * A throw anywhere inside propagates to processRecording's containment
 * (→ scheduleRetry).
 */
async function runSummarizeStep(
    r: ResolvedDeps,
    recording: Recording,
): Promise<{ outcome: ProcessRecordingOutcome }> {
    return withHeartbeat(
        {
            db: r.db,
            recordingId: recording.id,
            intervalMs: r.heartbeatIntervalMs,
            updateRecordingFn: r.update,
        },
        async () => {
            let current = recording;

            if (!present(current.summary_md)) {
                // Resolve the owner's BYOK keys server-side — mirror of
                // automation's best-effort lookup (a failure degrades to no
                // BYOK, i.e. {}). Only resolved when the LLM actually runs.
                let apiKeys: UserApiKeys;
                try {
                    apiKeys = await r.getUserApiKeys(current.user_id, r.db);
                } catch {
                    apiKeys = {};
                }

                const summary = await r.generateSummary({
                    transcriptText: current.transcript_text ?? "",
                    utterances: current.utterances,
                    model: r.model(),
                    apiKeys,
                });

                const patch: RecordingPatch = {
                    summary_md: summary.summary_md,
                    action_items: summary.action_items,
                };
                if (current.title === DEFAULT_RECORDING_TITLE) {
                    patch.title = summary.title;
                }
                current =
                    (await r.update(r.db, current.id, patch)) ??
                    ({ ...current, ...patch } as Recording);
            }

            if (!present(current.transcript_document_id)) {
                const { documentId } = await r.persistPdf({
                    db: r.db,
                    recording: current,
                });
                current =
                    (await r.update(r.db, current.id, {
                        transcript_document_id: documentId,
                    })) ??
                    ({
                        ...current,
                        transcript_document_id: documentId,
                    } as Recording);
            }

            const ready = await r.claim(
                r.db,
                recording.id,
                "summarizing",
                "ready",
            );
            if (!ready) return { outcome: "lost-claim" as const };

            if (ready.chat_id) {
                try {
                    await r.insertSummaryMessage(r.db, {
                        chatId: ready.chat_id,
                        userId: ready.user_id,
                        recording: ready,
                    });
                } catch (err) {
                    // The recording IS ready; a chat that vanished between
                    // capture and ready is tolerated (log-and-continue).
                    console.warn(
                        `[recordings] summary chat post failed for recording ${ready.id}`,
                        err,
                    );
                }
            }
            return { outcome: "ready" as const };
        },
    );
}

/**
 * Drive one recording as far as it can go in this invocation. Never throws: a
 * step failure hands off to the store's scheduleRetry (which fails the row at
 * the cap), and every transition is CAS-claimed so competing workers resolve to
 * one owner. submit and a non-completed poll are terminal for the invocation
 * (the next scheduler tick re-claims via next_attempt_at); a completed poll
 * falls straight through to summarize.
 */
export async function processRecording(
    db: Db,
    recordingId: string,
    deps: ProcessRecordingDeps = {},
): Promise<{ outcome: ProcessRecordingOutcome }> {
    const r = resolveDeps(db, deps);

    const initial = await r.getRecordingAny(db, recordingId);
    if (!initial) return { outcome: "missing" };

    const step = nextStep(initial);
    if (step === "done") return { outcome: "done" };

    try {
        if (step === "submit") {
            return await runSubmitStep(r, initial);
        }
        if (step === "poll") {
            const polled = await runPollStep(r, initial);
            if (polled.kind === "terminal") {
                return { outcome: polled.outcome };
            }
            // completed → the row is now claimed to summarizing; summarize now.
            return await runSummarizeStep(r, polled.recording);
        }
        // step === "summarize": a stall-recovered row re-entered mid-flight.
        // Claim its ACTUAL current status → summarizing before doing the work.
        const claimed = await r.claim(
            db,
            recordingId,
            initial.status,
            "summarizing",
        );
        if (!claimed) return { outcome: "lost-claim" };
        return await runSummarizeStep(r, claimed);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
            const outcome = await retryOutcome(
                r,
                recordingId,
                message,
                initial.retry_count,
            );
            return { outcome };
        } catch (persistErr) {
            // Even the failure bookkeeping failed (db down mid-run). The stall
            // sweeper will recover the row; log and report failed.
            console.error(
                `[recordings] recording ${recordingId} failed AND could not persist the failure`,
                { stepError: message, persistErr },
            );
            return { outcome: "failed" };
        }
    }
}

export interface ProcessDueRecordingsResult {
    /** Recordings actually worked this tick (processRecording ran; any outcome
     * other than missing/lost-claim). */
    processed: number;
    /** Recordings that were due at this tick (queued/transcribing + backoff
     * elapsed). */
    due: number;
}

export interface ProcessDueRecordingsDeps extends ProcessRecordingDeps {
    listDueRecordingsFn?: typeof listDueRecordings;
    processRecordingFn?: typeof processRecording;
}

/**
 * One scheduler tick's worth of recording processing: list due recordings, then
 * work them STRICTLY SEQUENTIALLY (the store's claim/heartbeat model assumes a
 * single worker per row, and serial processing keeps AssemblyAI/LLM concurrency
 * at one). Each recording is individually wrapped: one poisoned row cannot
 * starve the rest of the batch. Throws only when the recordings table itself is
 * unreachable — the scheduler logs and skips.
 */
export async function processDueRecordings(
    db: Db,
    opts: { limit: number },
    deps: ProcessDueRecordingsDeps = {},
): Promise<ProcessDueRecordingsResult> {
    const listFn = deps.listDueRecordingsFn ?? listDueRecordings;
    const processFn = deps.processRecordingFn ?? processRecording;

    const due = await listFn(db, { limit: opts.limit });
    let processed = 0;
    for (const recording of due) {
        try {
            const { outcome } = await processFn(db, recording.id, deps);
            if (outcome !== "missing" && outcome !== "lost-claim") {
                processed += 1;
            }
        } catch (err) {
            console.error(
                `[recordings] processRecording crashed for recording ${recording.id}`,
                err,
            );
        }
    }
    return { processed, due: due.length };
}
