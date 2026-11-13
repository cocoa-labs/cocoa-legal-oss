// backend/src/lib/libreoffice.test.ts
//
// convertWithLibreOffice spawns soffice directly. CI has no LibreOffice, so
// every conversion test runs against a fake soffice shell script written to a
// temp dir at runtime (mode 0o755, so nothing executable is committed) and
// injected through the `binaryPath` option — no env mutation, no global state.
// The fake parses `--outdir` and the trailing input path the way the real
// binary does, and records what it saw so the test can assert on the argv.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    DOCUMENT_CONVERSION_FAILED,
    DOCUMENT_CONVERSION_TIMEOUT,
    DOCUMENT_CONVERTER_UNAVAILABLE,
    DocumentConverterError,
    type ExecFileError,
    conversionTimeoutMs,
    convertWithLibreOffice,
    isSpawnFailure,
    resolveSofficeBinary,
} from "./libreoffice";

function testExplicitPathWins(): void {
    const seen: string[] = [];
    const result = resolveSofficeBinary({
        env: {
            SOFFICE_BINARY_PATH: "/custom/soffice",
            PATH: "/nix/store/example/bin",
        },
        canExecute: (candidate) => {
            seen.push(candidate);
            return candidate === "/custom/soffice";
        },
    });
    assert.equal(result, "/custom/soffice");
    assert.deepEqual(seen, ["/custom/soffice"]);
}

function testPathDiscoveryFindsNixAndHomebrew(): void {
    for (const directory of [
        "/nix/store/abc-libreoffice/bin",
        "/opt/homebrew/bin",
    ]) {
        const result = resolveSofficeBinary({
            env: { PATH: directory },
            platform: "linux",
            knownPaths: [],
            canExecute: (candidate) => candidate === `${directory}/soffice`,
        });
        assert.equal(result, `${directory}/soffice`);
    }
}

function testKnownLocationFallback(): void {
    const result = resolveSofficeBinary({
        env: { PATH: "" },
        platform: "linux",
        knownPaths: ["/custom-known/libreoffice"],
        canExecute: (candidate) => candidate === "/custom-known/libreoffice",
    });
    assert.equal(result, "/custom-known/libreoffice");
}

function testMissingAndInvalidConfiguredBinary(): void {
    for (const env of [
        { PATH: "" },
        { PATH: "", SOFFICE_BINARY_PATH: "/missing/soffice" },
    ]) {
        assert.throws(
            () =>
                resolveSofficeBinary({
                    env,
                    knownPaths: [],
                    canExecute: () => false,
                }),
            (error: unknown) =>
                error instanceof DocumentConverterError &&
                error.code === DOCUMENT_CONVERTER_UNAVAILABLE,
        );
    }
}

function testTimeoutBounds(): void {
    assert.equal(conversionTimeoutMs(undefined), 180_000);
    assert.equal(conversionTimeoutMs(""), 180_000);
    assert.equal(conversionTimeoutMs("not-a-number"), 180_000);
    assert.equal(conversionTimeoutMs("25"), 1_000);
    assert.equal(conversionTimeoutMs("999999"), 300_000);
    assert.equal(conversionTimeoutMs("45000"), 45_000);
}

// --- fake soffice -------------------------------------------------------

/** Where the current fake writes what it observed, one `key=value` per line. */
let recordPath = "";
let scratchDir = "";

/**
 * Write an executable stand-in for soffice. `body` runs after the argv has
 * been parsed into $input / $outdir / $fmt / $envarg and recorded, exactly
 * as the real binary would receive them.
 */
async function writeFakeSoffice(name: string, body: string): Promise<string> {
    const scriptPath = path.join(scratchDir, name);
    const script = [
        "#!/bin/sh",
        'outdir=""; input=""; fmt=""; envarg=""',
        "while [ $# -gt 0 ]; do",
        '  case "$1" in',
        '    --outdir) outdir="$2"; shift 2 ;;',
        '    --convert-to) fmt="$2"; shift 2 ;;',
        '    -env:*) envarg="$1"; shift ;;',
        "    -*) shift ;;",
        '    *) input="$1"; shift ;;',
        "  esac",
        "done",
        "{",
        '  echo "input=$(basename "$input")"',
        '  echo "outdir=$outdir"',
        '  echo "fmt=$fmt"',
        '  echo "envarg=$envarg"',
        `} > ${JSON.stringify(recordPath)}`,
        // Real soffice names the output after the input's basename.
        "stem=$(basename \"$input\" | sed 's/\\.[^.]*$//')",
        body,
        "",
    ].join("\n");
    await writeFile(scriptPath, script, { mode: 0o755 });
    await chmod(scriptPath, 0o755); // defeat a restrictive umask
    return scriptPath;
}

async function readRecord(): Promise<Record<string, string>> {
    const raw = await readFile(recordPath, "utf-8");
    return Object.fromEntries(
        raw
            .split("\n")
            .filter(Boolean)
            .map((line): [string, string] => {
                const at = line.indexOf("=");
                return [line.slice(0, at), line.slice(at + 1)];
            }),
    );
}

const WORK_DIR_PREFIX = "coco-soffice-";

async function workDirsInTmp(): Promise<string[]> {
    const entries = await readdir(os.tmpdir());
    return entries.filter((entry) => entry.startsWith(WORK_DIR_PREFIX)).sort();
}

// --- conversion tests ---------------------------------------------------

/**
 * Root cause 1: `libreoffice-convert` failed the conversion whenever stderr
 * contained "error", so a container's fontconfig warning turned a good PDF
 * into a permanent 422. Success must be judged by the output file alone.
 */
async function testStderrNoiseStillSucceeds(): Promise<void> {
    const binaryPath = await writeFakeSoffice(
        "soffice-noisy",
        [
            'echo "Fontconfig error: Cannot load default config file" >&2',
            'echo "dbus[42]: Failed to connect to socket: No such file" >&2',
            'echo "%PDF-1.4 fake" > "$outdir/$stem.pdf"',
            "exit 0",
        ].join("\n"),
    );

    const converted = await convertWithLibreOffice(Buffer.from("docx bytes"), {
        binaryPath,
        inputExtension: "docx",
    });
    assert.ok(
        converted.toString("utf-8").startsWith("%PDF"),
        "expected the written PDF back despite stderr noise",
    );

    const record = await readRecord();
    // The extension must reach the temp file soffice actually opens.
    assert.equal(record.input, "input.docx");
    assert.equal(record.fmt, "pdf");
    // Per-invocation user profile, as a file:// URL inside the work dir.
    const PREFIX = "-env:UserInstallation=";
    assert.ok(
        record.envarg.startsWith(`${PREFIX}file://`),
        `unexpected profile arg: ${record.envarg}`,
    );
    const workDir = path.dirname(record.outdir);
    assert.equal(
        fileURLToPath(record.envarg.slice(PREFIX.length)),
        path.join(workDir, "profile"),
    );
}

/** No `inputExtension`: the magic bytes decide. PK\x03\x04 => docx. */
async function testInputExtensionSniffedFromMagicBytes(): Promise<void> {
    const binaryPath = await writeFakeSoffice(
        "soffice-sniff",
        ['echo "%PDF-1.4 fake" > "$outdir/$stem.pdf"', "exit 0"].join("\n"),
    );

    const zipish = Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),
        Buffer.from("rest of a docx"),
    ]);
    await convertWithLibreOffice(zipish, { binaryPath });
    assert.equal((await readRecord()).input, "input.docx");

    await convertWithLibreOffice(Buffer.from("<!DOCTYPE html><html></html>"), {
        binaryPath,
    });
    assert.equal((await readRecord()).input, "input.html");
}

/** Non-zero exit AND no output file: that is a real document failure (422). */
async function testFailedExitWithoutOutput(): Promise<void> {
    const binaryPath = await writeFakeSoffice(
        "soffice-broken",
        ['echo "Error: source file could not be loaded" >&2', "exit 3"].join(
            "\n",
        ),
    );

    await assert.rejects(
        convertWithLibreOffice(Buffer.from("docx"), { binaryPath }),
        (error: unknown) =>
            error instanceof DocumentConverterError &&
            error.code === DOCUMENT_CONVERSION_FAILED &&
            error.message === "LibreOffice could not convert the document.",
    );
}

/**
 * The other half of "the output file is the verdict": a clean exit 0 is not
 * enough on its own — a zero-byte rendition is still a failed conversion.
 */
async function testEmptyOutputIsFailure(): Promise<void> {
    const binaryPath = await writeFakeSoffice(
        "soffice-empty",
        ['> "$outdir/$stem.pdf"', "exit 0"].join("\n"),
    );

    await assert.rejects(
        convertWithLibreOffice(Buffer.from("docx"), { binaryPath }),
        (error: unknown) =>
            error instanceof DocumentConverterError &&
            error.code === DOCUMENT_CONVERSION_FAILED,
    );
}

/** Our own timeout kill => TIMEOUT (503, retryable), not FAILED. */
async function testTimeout(): Promise<void> {
    const binaryPath = await writeFakeSoffice(
        "soffice-slow",
        // Redirect the sleep's stdio so it does not hold the pipes open after
        // the shell is killed — otherwise the callback waits for the orphan.
        ["sleep 3 </dev/null >/dev/null 2>&1", "exit 0"].join("\n"),
    );

    await assert.rejects(
        convertWithLibreOffice(Buffer.from("docx"), {
            binaryPath,
            timeoutMs: 1_000,
        }),
        (error: unknown) =>
            error instanceof DocumentConverterError &&
            error.code === DOCUMENT_CONVERSION_TIMEOUT &&
            error.message === "LibreOffice conversion exceeded 1000ms.",
    );
}

/** Binary absent (ENOENT) => UNAVAILABLE (503), never a document failure. */
async function testMissingBinary(): Promise<void> {
    await assert.rejects(
        convertWithLibreOffice(Buffer.from("docx"), {
            binaryPath: path.join(scratchDir, "definitely-not-here"),
        }),
        (error: unknown) => {
            assert.ok(error instanceof DocumentConverterError);
            assert.equal(error.code, DOCUMENT_CONVERTER_UNAVAILABLE);
            // Reached via the spawn-failure classifier, not by luck.
            assert.equal((error.cause as ExecFileError).code, "ENOENT");
            return true;
        },
    );
}

/**
 * A spawn failure whose errno is NOT in the old ENOENT/EACCES pair. soffice
 * never started, so nothing here is a statement about the document — but the
 * old enumeration let it fall past every branch (no output file, no `signal`,
 * `killed` unset) and land on a terminal 422 "This document could not be
 * converted to PDF."
 *
 * ENOTDIR is the one such errno a test can provoke portably: a path that
 * traverses *through* a regular file. It is a stand-in for the case that
 * actually bites in production — a container at its memory cap refusing
 * fork()/posix_spawn() with EAGAIN or ENOMEM, pinned directly below.
 */
async function testNonEnoentSpawnFailureIsUnavailable(): Promise<void> {
    const regularFile = path.join(scratchDir, "not-a-directory");
    await writeFile(regularFile, "just a file");

    await assert.rejects(
        convertWithLibreOffice(Buffer.from("docx"), {
            binaryPath: path.join(regularFile, "program", "soffice"),
        }),
        (error: unknown) => {
            assert.ok(error instanceof DocumentConverterError);
            assert.notEqual(
                error.code,
                DOCUMENT_CONVERSION_FAILED,
                "soffice never started, so the document cannot be the thing at fault",
            );
            assert.equal(error.code, DOCUMENT_CONVERTER_UNAVAILABLE);
            assert.equal((error.cause as ExecFileError).code, "ENOTDIR");
            return true;
        },
    );
}

/**
 * The classifier itself, against the error shapes Node really produces —
 * verified by probing execFile for each case. EAGAIN and ENOMEM are the
 * reason this widening exists (fork() refused at the memory cap) and cannot
 * be provoked from a test, so they are pinned here by shape. `syscall` is the
 * discriminator: Node sets it for spawn failures and for nothing else.
 */
function testSpawnFailureClassifier(): void {
    const shaped = (fields: Partial<ExecFileError>): ExecFileError =>
        Object.assign(new Error("probe"), fields) as ExecFileError;

    // Reported asynchronously, with the file appended to the syscall.
    for (const code of ["ENOENT", "EACCES", "EAGAIN", "EMFILE", "ENFILE"]) {
        assert.equal(
            isSpawnFailure(shaped({ code, syscall: "spawn /usr/bin/soffice" })),
            true,
            `${code} must be treated as a spawn failure`,
        );
    }
    // Thrown synchronously, with a bare "spawn" and no file.
    for (const code of ["ENOTDIR", "ENOEXEC", "ENOMEM"]) {
        assert.equal(
            isSpawnFailure(shaped({ code, syscall: "spawn" })),
            true,
            `${code} must be treated as a spawn failure`,
        );
    }
    // The process DID run: these must stay out, or a genuinely bad document
    // would be reported as a retryable environment problem forever.
    assert.equal(isSpawnFailure(shaped({ code: 3, killed: false })), false);
    assert.equal(
        isSpawnFailure(shaped({ code: null as never, signal: "SIGKILL" })),
        false,
    );
    assert.equal(isSpawnFailure(shaped({})), false);
    // Not every syscall is the spawn syscall.
    assert.equal(
        isSpawnFailure(shaped({ code: "ENOENT2", syscall: "spawnSomethingElse" })),
        false,
    );
}

/**
 * soffice wrote a rendition but we could not read it back. That is an
 * environment failure (EMFILE under load, a transient EACCES/EIO on the temp
 * filesystem), not a bad document — only a genuinely *absent* file means no
 * output. Provoked portably by making the output path a directory (EISDIR).
 */
async function testUnreadableOutputIsUnavailable(): Promise<void> {
    const binaryPath = await writeFakeSoffice(
        "soffice-unreadable",
        ['mkdir -p "$outdir/$stem.pdf"', "exit 0"].join("\n"),
    );

    await assert.rejects(
        convertWithLibreOffice(Buffer.from("docx"), { binaryPath }),
        (error: unknown) => {
            assert.ok(error instanceof DocumentConverterError);
            assert.notEqual(
                error.code,
                DOCUMENT_CONVERSION_FAILED,
                "a read error is not evidence that the document is unconvertible",
            );
            assert.equal(error.code, DOCUMENT_CONVERTER_UNAVAILABLE);
            return true;
        },
    );
}

/**
 * An *external* SIGKILL — the host's memory cap — arrives with
 * `killed === false` and `signal === "SIGKILL"`. The old classifier let that
 * fall through to FAILED, telling the user their document was bad and
 * closing off the retry. It is an environment failure: UNAVAILABLE (503).
 */
async function testExternalSigkillIsUnavailable(): Promise<void> {
    const binaryPath = await writeFakeSoffice(
        "soffice-oom",
        ["kill -9 $$", "exit 0"].join("\n"),
    );

    await assert.rejects(
        convertWithLibreOffice(Buffer.from("docx"), {
            binaryPath,
            timeoutMs: 30_000,
        }),
        (error: unknown) => {
            assert.ok(error instanceof DocumentConverterError);
            assert.notEqual(
                error.code,
                DOCUMENT_CONVERSION_FAILED,
                "an externally killed soffice must not be reported as a bad document",
            );
            assert.equal(error.code, DOCUMENT_CONVERTER_UNAVAILABLE);
            return true;
        },
    );
}

/** The work dir holds the source document, a user profile and the PDF. */
async function testTempDirCleanup(): Promise<void> {
    const binaryPath = await writeFakeSoffice(
        "soffice-cleanup",
        ['echo "%PDF-1.4 fake" > "$outdir/$stem.pdf"', "exit 0"].join("\n"),
    );

    const before = await workDirsInTmp();
    await convertWithLibreOffice(Buffer.from("docx"), {
        binaryPath,
        inputExtension: ".DOCX", // also proves dot/case normalisation
    });
    const record = await readRecord();
    assert.equal(record.input, "input.docx");

    // The exact directory that existed mid-conversion is gone...
    const workDir = path.dirname(record.outdir);
    assert.ok(workDir.startsWith(path.join(os.tmpdir(), WORK_DIR_PREFIX)));
    assert.equal(existsSync(workDir), false, `${workDir} was left behind`);
    // ...and nothing else accumulated either.
    assert.deepEqual(await workDirsInTmp(), before);

    // A failing conversion must clean up too.
    const failing = await writeFakeSoffice("soffice-cleanup-fail", "exit 1");
    await assert.rejects(
        convertWithLibreOffice(Buffer.from("docx"), { binaryPath: failing }),
        (error: unknown) => error instanceof DocumentConverterError,
    );
    assert.deepEqual(await workDirsInTmp(), before);
}

/**
 * The concurrency gate must actually be in the path of a conversion — not
 * merely correct in isolation. Each soffice peaks at 150-300 MB, so two at
 * once on a small container is the SIGKILL this whole taxonomy exists to
 * explain; a `gate()(...)` accidentally reduced to a pass-through would be
 * invisible to every other test in this file.
 *
 * The fake blocks until the test releases it, so under a working gate only
 * one instance can ever be alive while both callers are pending.
 */
async function testConversionsAreSerialisedByTheGate(): Promise<void> {
    const logPath = path.join(scratchDir, "gate-log.txt");
    const releasePath = path.join(scratchDir, "gate-release");
    await rm(logPath, { force: true });
    await rm(releasePath, { force: true });

    const binaryPath = await writeFakeSoffice(
        "soffice-gated",
        [
            `LOG=${JSON.stringify(logPath)}`,
            `RELEASE=${JSON.stringify(releasePath)}`,
            'echo "start" >> "$LOG"',
            // Bounded, so a failing assertion can never leave a spinner behind.
            "i=0",
            'while [ ! -f "$RELEASE" ] && [ $i -lt 200 ]; do',
            "  sleep 0.05; i=$((i+1))",
            "done",
            'echo "end" >> "$LOG"',
            'echo "%PDF-1.4 fake" > "$outdir/$stem.pdf"',
            "exit 0",
        ].join("\n"),
    );

    const readLog = async (): Promise<string[]> =>
        (await readFile(logPath, "utf-8").catch(() => ""))
            .split("\n")
            .filter(Boolean);

    const both = Promise.all([
        convertWithLibreOffice(Buffer.from("docx one"), {
            binaryPath,
            timeoutMs: 30_000,
        }),
        convertWithLibreOffice(Buffer.from("docx two"), {
            binaryPath,
            timeoutMs: 30_000,
        }),
    ]);

    // Give a leaking gate every chance to show a second instance, and stop
    // waiting the moment it does. A working gate simply waits out the window.
    const deadline = Date.now() + 1_500;
    let observed = await readLog();
    while (Date.now() < deadline) {
        observed = await readLog();
        if (observed.filter((line) => line === "start").length >= 2) break;
        await new Promise((r) => setTimeout(r, 25));
    }

    await writeFile(releasePath, "go");
    const results = await both;

    assert.equal(
        observed.filter((line) => line === "start").length,
        1,
        `two soffice processes were alive at once (log: ${observed.join(",")}) — conversions are not going through the gate`,
    );
    // End to end: strictly alternating, so the second only began once the
    // first had finished.
    assert.deepEqual(await readLog(), ["start", "end", "start", "end"]);
    for (const converted of results) {
        assert.ok(converted.toString("utf-8").startsWith("%PDF"));
    }
}

async function main(): Promise<void> {
    testExplicitPathWins();
    testPathDiscoveryFindsNixAndHomebrew();
    testKnownLocationFallback();
    testMissingAndInvalidConfiguredBinary();
    testTimeoutBounds();
    testSpawnFailureClassifier();

    // The conversion gate is built once, lazily, from the environment on the
    // first conversion below. Pin it to the default of 1 so a developer's
    // exported override cannot change what these tests mean.
    delete process.env.LIBREOFFICE_MAX_CONCURRENT;

    scratchDir = await mkdtemp(path.join(os.tmpdir(), "coco-lo-test-"));
    recordPath = path.join(scratchDir, "record.txt");
    try {
        await testStderrNoiseStillSucceeds();
        await testInputExtensionSniffedFromMagicBytes();
        await testFailedExitWithoutOutput();
        await testEmptyOutputIsFailure();
        await testTimeout();
        await testMissingBinary();
        await testNonEnoentSpawnFailureIsUnavailable();
        await testExternalSigkillIsUnavailable();
        await testUnreadableOutputIsUnavailable();
        await testTempDirCleanup();
        await testConversionsAreSerialisedByTheGate();
    } finally {
        await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    }
    console.log("libreoffice.test.ts: all passed");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
