import { performance } from "node:perf_hooks";

import { convertWithLibreOffice } from "./libreoffice";

/**
 * The warm-up document, inline rather than a committed fixture.
 *
 * RTF because it costs nothing and still proves everything that matters: no
 * new dependency and no binary fixture to keep in the repo, ~90 deterministic
 * bytes, and soffice nonetheless has to run its whole pipeline to convert it
 * — bootstrap a user profile, build the fontconfig cache, load the Writer
 * import filter and the PDF export filter. That is precisely the one-off
 * first-run cost we want paid at boot rather than by the first user waiting
 * on a signature request.
 *
 * The font table names Times New Roman on purpose: that is what the document
 * generator hardcodes (`docxAssembly.ts`), so a passing warm-up also
 * exercises the fontconfig substitution to Liberation Serif that the fonts in
 * `nixpacks.toml` exist to provide.
 */
const WARM_UP_RTF = Buffer.from(
    "{\\rtf1\\ansi{\\fonttbl{\\f0 Times New Roman;}}\\f0\\fs22 Coco Legal converter warm-up.}",
    "latin1",
);

const PDF_MAGIC = Buffer.from("%PDF", "latin1");

export type WarmUpResult =
    | { ok: true; ms: number }
    | { ok: false; ms: number; error: string };

export interface WarmUpOptions {
    /** Overrides binary discovery. Also the injection point for tests. */
    binaryPath?: string;
    timeoutMs?: number;
}

/**
 * Whether the boot warm-up should run. Default ON — a cold converter is a real
 * cost paid by the first user, so the warm-up earns its keep.
 *
 * It exists as a switch because the warm-up spawns a second soffice
 * (~150-300 MB RSS) while the app is already serving traffic. If that is what
 * tips this container over the platform's memory cap, the OOM killer may take
 * the node process rather than soffice, and the restart policy then boots an
 * app that warms up again — a crash loop whose only other cure is a revert and
 * a redeploy. LIBREOFFICE_WARMUP_ENABLED=false breaks that loop from the
 * dashboard, at the cost of the first conversion paying the cold-start.
 *
 * Boolean convention follows lib/automation/env.ts: a default-ON safety flips
 * off only for a case-insensitive "false", so junk ("0", "off", "no") can
 * never silently disarm the warm-up.
 */
export function libreOfficeWarmupEnabled(
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    return (env.LIBREOFFICE_WARMUP_ENABLED ?? "").toLowerCase() !== "false";
}

/**
 * Flatten a converter failure into one log-friendly line. `cause` is where the
 * detail actually lives — `DocumentConverterError` messages are deliberately
 * generic, and the captured soffice stderr (the fontconfig complaint, the
 * missing filter) hangs off the cause.
 */
function describeError(error: unknown): string {
    if (!(error instanceof Error)) return String(error);
    const code = (error as { code?: unknown }).code;
    const cause = error.cause instanceof Error ? error.cause.message : null;
    return [
        code ? `[${String(code)}] ` : "",
        error.message,
        cause ? ` (cause: ${cause})` : "",
    ].join("");
}

/**
 * Convert one tiny document at boot and verify the result really is a PDF.
 *
 * Why this exists: `soffice --version` (the old startup check) and
 * `checkLibreOfficeReachable` (the `/health/ready` check) both pass happily on
 * an image where every real conversion fails — neither touches an import
 * filter, fontconfig, or the export pipeline. They answer "is the binary
 * present", which was never the question. This answers "does a conversion
 * yield a PDF" — the thing production got wrong while its startup log claimed
 * everything was fine.
 *
 * Deliberately NOT wired into `/health/ready`. A soffice spawn per readiness
 * probe would cost 150-300 MB of RSS on every poll, so under memory pressure
 * the probe itself becomes what tips the container over — the check would
 * flap for exactly the reason it was meant to catch. Conversion health only
 * changes when the image changes, so once per boot is the truthful signal and
 * readiness stays cheap.
 *
 * Never throws and never rejects. Its caller is the `listen` callback, where a
 * throw would take the process down and a rejection would surface as a crash
 * in the logs; a cold converter has to degrade to a loud line, not a boot
 * loop.
 *
 * This does share the converter's concurrency gate, so a real request arriving
 * mid-warm-up queues behind it — which is strictly no worse than not warming
 * up at all, since that request would otherwise pay the same cold-start cost
 * itself.
 */
export async function warmUpLibreOffice(
    options: WarmUpOptions = {},
): Promise<WarmUpResult> {
    // Monotonic: a container's clock can still be stepping by NTP this early
    // in its life, which would make a Date.now() delta meaningless or negative.
    const startedAt = performance.now();
    const elapsed = (): number => Math.round(performance.now() - startedAt);

    try {
        const pdf = await convertWithLibreOffice(WARM_UP_RTF, {
            inputExtension: "rtf",
            ...options,
        });
        // A warm-up that accepts whatever bytes come back proves nothing: the
        // failure mode being guarded against is precisely a startup log that
        // claims success while conversion is broken.
        if (!pdf.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
            return {
                ok: false,
                ms: elapsed(),
                error: `converter returned ${pdf.length} bytes with no %PDF header`,
            };
        }
        return { ok: true, ms: elapsed() };
    } catch (error) {
        return { ok: false, ms: elapsed(), error: describeError(error) };
    }
}
