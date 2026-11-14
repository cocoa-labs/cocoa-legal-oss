import { execFile } from "node:child_process";
import { constants, accessSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
    createConcurrencyGate,
    envInt,
    type ConcurrencyGate,
} from "./concurrency";

export const DOCUMENT_CONVERTER_UNAVAILABLE =
    "DOCUMENT_CONVERTER_UNAVAILABLE" as const;
export const DOCUMENT_CONVERSION_TIMEOUT =
    "DOCUMENT_CONVERSION_TIMEOUT" as const;
export const DOCUMENT_CONVERSION_FAILED = "DOCUMENT_CONVERSION_FAILED" as const;

export type DocumentConverterErrorCode =
    | typeof DOCUMENT_CONVERTER_UNAVAILABLE
    | typeof DOCUMENT_CONVERSION_TIMEOUT
    | typeof DOCUMENT_CONVERSION_FAILED;

export class DocumentConverterError extends Error {
    readonly code: DocumentConverterErrorCode;

    constructor(
        code: DocumentConverterErrorCode,
        message: string,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = "DocumentConverterError";
        this.code = code;
    }
}

interface ResolveOptions {
    env?: Record<string, string | undefined>;
    platform?: NodeJS.Platform;
    canExecute?: (candidate: string) => boolean;
    knownPaths?: string[];
}

const KNOWN_PATHS: Partial<Record<NodeJS.Platform, string[]>> = {
    darwin: ["/Applications/LibreOffice.app/Contents/MacOS/soffice"],
    linux: [
        "/usr/bin/soffice",
        "/usr/bin/libreoffice",
        "/snap/bin/libreoffice",
        "/opt/libreoffice/program/soffice",
        "/opt/libreoffice7.6/program/soffice",
    ],
    win32: [
        "C:/Program Files/LibreOffice/program/soffice.exe",
        "C:/Program Files (x86)/LibreOffice/program/soffice.exe",
    ],
};

function executableNames(platform: NodeJS.Platform): string[] {
    return platform === "win32"
        ? ["soffice.exe", "libreoffice.exe"]
        : ["soffice", "libreoffice"];
}

function defaultCanExecute(candidate: string): boolean {
    try {
        accessSync(candidate, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * Resolve the LibreOffice CLI without relying on libreoffice-convert's short
 * hard-coded path list. Nixpacks and Homebrew put `soffice` on PATH in locations
 * such as /nix/store/.../bin and /opt/homebrew/bin; both were invisible to the
 * dependency's default resolver.
 */
export function resolveSofficeBinary(options: ResolveOptions = {}): string {
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const canExecute = options.canExecute ?? defaultCanExecute;

    const configured = env.SOFFICE_BINARY_PATH?.trim();
    if (configured) {
        if (canExecute(configured)) return configured;
        throw new DocumentConverterError(
            DOCUMENT_CONVERTER_UNAVAILABLE,
            `SOFFICE_BINARY_PATH is not executable: ${configured}`,
        );
    }

    const delimiter = platform === "win32" ? ";" : ":";
    const fromPath = (env.PATH ?? "")
        .split(delimiter)
        .map((entry) => entry.trim())
        .filter(Boolean)
        .flatMap((directory) =>
            executableNames(platform).map((name) => path.join(directory, name)),
        );
    const known = options.knownPaths ?? KNOWN_PATHS[platform] ?? [];
    const candidates = [...new Set([...fromPath, ...known])];
    const resolved = candidates.find(canExecute);
    if (resolved) return resolved;

    throw new DocumentConverterError(
        DOCUMENT_CONVERTER_UNAVAILABLE,
        "LibreOffice is unavailable: no executable soffice binary was found.",
    );
}

interface ConversionOptions {
    /** LibreOffice `--convert-to` target. Defaults to ".pdf". */
    outputExtension?: string;
    /**
     * Input format hint ("docx" / ".docx"). soffice content-sniffs regardless,
     * but naming the temp file with the right extension makes detection
     * reliable — the old dependency wrote an extensionless `source` file and
     * left LibreOffice to guess.
     */
    inputExtension?: string;
    /** Overrides discovery. Also the injection point for tests. */
    binaryPath?: string;
    timeoutMs?: number;
}

// Legal-scale packets can legitimately run to hundreds of pages. Keep the
// converter fail-bounded, but do not kill a healthy Writer process at the
// one-minute mark merely because pagination and PDF export are substantial.
const DEFAULT_CONVERSION_TIMEOUT_MS = 180_000;
const MIN_CONVERSION_TIMEOUT_MS = 1_000;
const MAX_CONVERSION_TIMEOUT_MS = 300_000;

export function conversionTimeoutMs(
    raw = process.env.LIBREOFFICE_CONVERSION_TIMEOUT_MS,
): number {
    if (!raw?.trim()) return DEFAULT_CONVERSION_TIMEOUT_MS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return DEFAULT_CONVERSION_TIMEOUT_MS;
    return Math.min(
        Math.max(Math.trunc(parsed), MIN_CONVERSION_TIMEOUT_MS),
        MAX_CONVERSION_TIMEOUT_MS,
    );
}

function isTimeoutError(error: Error): boolean {
    const shaped = error as Error & { code?: string; killed?: boolean };
    return (
        shaped.code === "ETIMEDOUT" ||
        shaped.killed === true ||
        /timed?\s*out/i.test(shaped.message)
    );
}

const TEMP_DIR_PREFIX = "cocoa-soffice-";
const MAX_EXEC_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_LOGGED_STDERR_CHARS = 500;

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/** Shape of the error `execFile` hands back, across all its failure modes. */
export type ExecFileError = Error & {
    /** An errno name for spawn failures; the numeric exit status otherwise. */
    code?: string | number;
    /** True only when *Node's own* timeout killed the child. */
    killed?: boolean;
    signal?: NodeJS.Signals | null;
    /**
     * Set only when the *spawn syscall itself* failed: "spawn <file>" for the
     * errnos Node reports asynchronously (ENOENT, EACCES, EAGAIN, EMFILE,
     * ENFILE) and a bare "spawn" for the ones it throws synchronously
     * (ENOTDIR, ENOEXEC, ENOMEM). Never set for an exit status or a signal.
     */
    syscall?: string;
};

/**
 * Did soffice fail to *start*? `syscall` is the exact discriminator: Node
 * stamps every failure of the spawn syscall with it and nothing else — a
 * non-zero exit and an external SIGKILL both leave it undefined.
 *
 * The whole family has to be retryable, not just the missing/unrunnable
 * binary. On a container at its memory cap, fork()/posix_spawn() is refused
 * outright with EAGAIN or ENOMEM: soffice never runs, so `signal` and
 * `killed` are both unset and the old ENOENT/EACCES enumeration dropped it
 * through to a terminal 422. That is the same memory-pressure condition the
 * SIGKILL branch exists for, only caught one instruction earlier. ENOEXEC
 * matters for the same reason from the other direction — a broken
 * LibreOffice layer in the image would otherwise be reported to the user as
 * their document being permanently bad.
 *
 * None of these are statements about the document, so all of them stay 503.
 *
 * Exported so that EAGAIN and ENOMEM — the two that actually bite in
 * production and that no test can provoke — can still be pinned against the
 * error shapes Node really produces.
 */
export function isSpawnFailure(error: ExecFileError): boolean {
    return (
        /^spawn(\s|$)/.test(error.syscall ?? "") ||
        error.code === "ENOENT" ||
        error.code === "EACCES"
    );
}

/**
 * Reduce an extension to something safe to splice into a filename. Returns
 * null when nothing usable is left, so callers can fall back.
 */
function safeExtension(raw: string | undefined): string | null {
    const cleaned = (raw ?? "")
        .trim()
        .replace(/^\.+/, "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
    return cleaned || null;
}

/**
 * `--convert-to` accepts a bare extension ("pdf") or an extension plus an
 * explicit filter ("pdf:writer_pdf_Export"). Keep the whole spec for the CLI
 * but derive the output *filename* extension from the part before the colon,
 * and tolerate the historical leading dot in `outputExtension` (".pdf"),
 * which soffice itself would reject.
 */
function normalizeOutputFormat(raw: string | undefined): {
    format: string;
    extension: string;
} {
    const format = (raw ?? "").trim().replace(/^\.+/, "") || "pdf";
    return {
        format,
        extension: safeExtension(format.split(":")[0]) ?? "pdf",
    };
}

/**
 * Best-effort format hint from the leading bytes. Only used when the caller
 * did not supply `inputExtension`; soffice still does its own content-based
 * type detection, so a wrong guess degrades to what we had before rather
 * than breaking the conversion.
 */
function sniffInputExtension(input: Buffer): string {
    if (input.subarray(0, 4).equals(ZIP_MAGIC)) return "docx";
    if (input.subarray(0, 8).equals(OLE2_MAGIC)) return "doc";

    let head = input.subarray(0, 256);
    // Strip a UTF-8 BOM so the text probes below see the real first char.
    if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
        head = head.subarray(3);
    }
    const text = head.toString("latin1");
    if (text.startsWith("{\\rtf")) return "rtf";
    const trimmed = text.trimStart().toLowerCase();
    if (trimmed.startsWith("<!doctype") || trimmed.startsWith("<html")) {
        return "html";
    }
    // Neutral: no extension-based claim about the format, leaving soffice's
    // content sniffing to decide (which is all the old dependency ever did).
    return "bin";
}

/**
 * Promisified `execFile` that *reports* rather than throws: a non-zero exit
 * is not by itself a failed conversion, so the caller needs the error, the
 * stderr and the chance to look at the output file before deciding.
 */
function execFileCapture(
    file: string,
    args: string[],
    timeoutMs: number,
): Promise<{ error: ExecFileError | null; stderr: string }> {
    return new Promise((resolve) => {
        try {
            execFile(
                file,
                args,
                {
                    timeout: timeoutMs,
                    // soffice can ignore SIGTERM; SIGKILL also keeps the
                    // classification below unambiguous.
                    killSignal: "SIGKILL",
                    maxBuffer: MAX_EXEC_BUFFER_BYTES,
                },
                (error, _stdout, stderr) => {
                    resolve({
                        error: (error as ExecFileError | null) ?? null,
                        stderr: String(stderr ?? ""),
                    });
                },
            );
        } catch (thrown) {
            resolve({
                error:
                    thrown instanceof Error
                        ? (thrown as ExecFileError)
                        : (new Error(String(thrown)) as ExecFileError),
                stderr: "",
            });
        }
    });
}

/**
 * Only one soffice at a time by default. Each process peaks around
 * 150-300 MB, and upload conversions, clean copies, transcript PDFs and
 * signature approvals all overlap in practice — enough concurrent instances
 * and the platform's memory cap SIGKILLs one mid-render. Tunable via
 * LIBREOFFICE_MAX_CONCURRENT without a redeploy; read lazily so dotenv has
 * loaded by the time the limit is fixed.
 */
let conversionGate: ConcurrencyGate | null = null;
function gate(): ConcurrencyGate {
    if (!conversionGate) {
        conversionGate = createConcurrencyGate(
            envInt("LIBREOFFICE_MAX_CONCURRENT", 1),
        );
    }
    return conversionGate;
}

/**
 * Convert a document by spawning the exact executable found by our resolver.
 *
 * Replaces the `libreoffice-convert` dependency, which decided a conversion
 * had failed whenever stderr contained the substring "error". A minimal
 * container emits fontconfig / dbus / GLib warnings on stderr while writing
 * a perfectly good PDF, so healthy conversions were reported as permanent
 * document failures. Here the *output file* is the only verdict.
 */
export async function convertWithLibreOffice(
    input: Buffer,
    options: ConversionOptions = {},
): Promise<Buffer> {
    const binaryPath = options.binaryPath ?? resolveSofficeBinary();
    const timeoutMs = options.timeoutMs ?? conversionTimeoutMs();
    const output = normalizeOutputFormat(options.outputExtension ?? ".pdf");
    const inputExtension =
        safeExtension(options.inputExtension) ?? sniffInputExtension(input);

    return gate()(() =>
        runConversion(input, {
            binaryPath,
            timeoutMs,
            inputExtension,
            outputFormat: output.format,
            outputExtension: output.extension,
        }),
    );
}

async function runConversion(
    input: Buffer,
    options: {
        binaryPath: string;
        timeoutMs: number;
        inputExtension: string;
        outputFormat: string;
        outputExtension: string;
    },
): Promise<Buffer> {
    const workDir = await mkdtemp(path.join(os.tmpdir(), TEMP_DIR_PREFIX));
    try {
        const profileDir = path.join(workDir, "profile");
        const outDir = path.join(workDir, "out");
        await mkdir(profileDir);
        await mkdir(outDir);
        const inputPath = path.join(workDir, `input.${options.inputExtension}`);
        await writeFile(inputPath, input);

        const { error, stderr } = await execFileCapture(
            options.binaryPath,
            [
                // A per-invocation user profile. soffice enforces one instance
                // per profile with a lock file, so conversions sharing a
                // profile serialise on each other or corrupt the instance.
                `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
                "--headless",
                "--norestore",
                "--nolockcheck",
                "--nodefault",
                "--nologo",
                "--convert-to",
                options.outputFormat,
                "--outdir",
                outDir,
                inputPath,
            ],
            options.timeoutMs,
        );

        const noise = stderr.trim();
        if (noise) {
            // Diagnostics only, and deliberately before the classification
            // below so a timeout or a kill still leaves a trace. Deciding
            // success from stderr is the bug this rewrite exists to remove.
            console.warn(
                `[libreoffice] stderr: ${noise.slice(0, MAX_LOGGED_STDERR_CHARS)}`,
            );
        }

        if (error) {
            // Node sets `killed` only when its own timeout did the killing.
            if (error.killed === true) {
                throw new DocumentConverterError(
                    DOCUMENT_CONVERSION_TIMEOUT,
                    `LibreOffice conversion exceeded ${options.timeoutMs}ms.`,
                    { cause: error },
                );
            }
            if (isSpawnFailure(error)) {
                throw new DocumentConverterError(
                    DOCUMENT_CONVERTER_UNAVAILABLE,
                    `LibreOffice executable could not be started: ${options.binaryPath}`,
                    { cause: error },
                );
            }
            if (error.signal) {
                // Killed by something other than us — in production that is
                // the host's memory cap sending SIGKILL. That is a property
                // of the environment, not of the document, so the envelope
                // stays retryable (503) instead of being told, permanently,
                // that its document is bad (422).
                throw new DocumentConverterError(
                    DOCUMENT_CONVERTER_UNAVAILABLE,
                    `LibreOffice was terminated by ${error.signal} before it finished.`,
                    { cause: error },
                );
            }
            // A non-zero exit with no signal is NOT decided here: soffice
            // returns non-zero for conditions under which it still wrote a
            // usable document. Fall through to the output file.
        }

        const converted = await readIfNonEmpty(
            path.join(outDir, `input.${options.outputExtension}`),
        );
        if (!converted) {
            throw new DocumentConverterError(
                DOCUMENT_CONVERSION_FAILED,
                "LibreOffice could not convert the document.",
                {
                    cause:
                        error ??
                        new Error(
                            noise
                                ? `soffice wrote no output. stderr: ${noise.slice(0, MAX_LOGGED_STDERR_CHARS)}`
                                : "soffice wrote no output.",
                        ),
                },
            );
        }
        return converted;
    } finally {
        // Never leak a work dir: it holds the source document, a full user
        // profile and the rendered PDF.
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
}

/**
 * Read the rendition, distinguishing "soffice produced nothing" from "we
 * could not read what soffice produced".
 *
 * Only ENOENT means there is genuinely no output, and only that answers the
 * question the caller is asking — so only that returns null and becomes a
 * terminal 422. Any other read error (EMFILE when the process is out of
 * descriptors, a transient EACCES or EIO on the temp filesystem) says
 * nothing about the document: soffice may well have written a perfect PDF
 * one line earlier. Those stay retryable rather than telling the user their
 * document is permanently unconvertible.
 */
async function readIfNonEmpty(filePath: string): Promise<Buffer | null> {
    try {
        const contents = await readFile(filePath);
        return contents.length > 0 ? contents : null;
    } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
            return null;
        }
        throw new DocumentConverterError(
            DOCUMENT_CONVERTER_UNAVAILABLE,
            "LibreOffice wrote a rendition that could not be read.",
            { cause: error },
        );
    }
}

export async function getLibreOfficeVersion(
    binaryPath = resolveSofficeBinary(),
    timeoutMs = 5_000,
): Promise<{ path: string; version: string }> {
    const version = await new Promise<string>((resolve, reject) => {
        execFile(
            binaryPath,
            ["--version"],
            { timeout: timeoutMs },
            (error, stdout) => {
                if (error) {
                    reject(
                        new DocumentConverterError(
                            isTimeoutError(error)
                                ? DOCUMENT_CONVERSION_TIMEOUT
                                : DOCUMENT_CONVERTER_UNAVAILABLE,
                            "LibreOffice executable could not be started.",
                            { cause: error },
                        ),
                    );
                    return;
                }
                resolve(stdout.trim() || "version unknown");
            },
        );
    });
    return { path: binaryPath, version };
}

/** Cheap readiness check: discovery + executable access, without spawning LO. */
export async function checkLibreOfficeReachable(): Promise<void> {
    resolveSofficeBinary();
}

export function converterHttpError(error: unknown): {
    status: number;
    code: DocumentConverterErrorCode;
    detail: string;
} | null {
    if (!(error instanceof DocumentConverterError)) return null;
    return {
        status: error.code === DOCUMENT_CONVERSION_FAILED ? 422 : 503,
        code: error.code,
        detail:
            error.code === DOCUMENT_CONVERTER_UNAVAILABLE
                ? "Document conversion is temporarily unavailable. The signature request remains pending and can be retried."
                : error.code === DOCUMENT_CONVERSION_TIMEOUT
                  ? "Document conversion timed out. The signature request remains pending and can be retried."
                  : "This document could not be converted to PDF.",
    };
}
