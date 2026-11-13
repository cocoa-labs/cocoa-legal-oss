// backend/src/lib/libreofficeWarmup.test.ts
//
// CI has no LibreOffice, so every case here runs against a fake soffice shell
// script written to a temp dir at runtime (mode 0o755, so nothing executable
// is committed) and injected through `binaryPath` — no env mutation, no global
// state, same technique as libreoffice.test.ts. `warmUpLibreOffice` is never
// called without a binaryPath, so nothing here depends on whether the machine
// running the suite happens to have a real soffice.
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
    libreOfficeWarmupEnabled,
    warmUpLibreOffice,
} from "./libreofficeWarmup";

let scratchDir = "";
/** Where the fake copies the document it was asked to convert. */
let inputCopyPath = "";
/** Where the fake records the input filename it was handed. */
let recordPath = "";

/**
 * Write an executable stand-in for soffice. `body` runs with $outdir and $stem
 * already parsed out of the argv, exactly as the real binary would see them.
 *
 * The source document is preserved by copying the file rather than echoing its
 * contents: RTF is mostly backslash escapes, and `echo` in a POSIX sh would
 * interpret \a and \f rather than pass them through.
 */
async function writeFakeSoffice(name: string, body: string): Promise<string> {
    const scriptPath = path.join(scratchDir, name);
    const script = [
        "#!/bin/sh",
        'outdir=""; input=""',
        "while [ $# -gt 0 ]; do",
        '  case "$1" in',
        '    --outdir) outdir="$2"; shift 2 ;;',
        "    --convert-to) shift 2 ;;",
        "    -*) shift ;;",
        '    *) input="$1"; shift ;;',
        "  esac",
        "done",
        `echo "input=$(basename "$input")" > ${JSON.stringify(recordPath)}`,
        `cp "$input" ${JSON.stringify(inputCopyPath)}`,
        // Real soffice names the output after the input's basename.
        "stem=$(basename \"$input\" | sed 's/\\.[^.]*$//')",
        body,
        "",
    ].join("\n");
    await writeFile(scriptPath, script, { mode: 0o755 });
    await chmod(scriptPath, 0o755); // defeat a restrictive umask
    return scriptPath;
}

const WRITE_A_PDF = [
    'echo "%PDF-1.4 fake" > "$outdir/$stem.pdf"',
    "exit 0",
].join("\n");

/**
 * The happy path, and the assertions that the warm-up is warming up the right
 * thing: a real conversion of the RTF constant, handed to soffice as an .rtf
 * so the import filter is not left guessing.
 */
async function testSuccessfulWarmUpReportsOk(): Promise<void> {
    const binaryPath = await writeFakeSoffice("soffice-ok", WRITE_A_PDF);

    const result = await warmUpLibreOffice({ binaryPath });

    assert.equal(result.ok, true);
    assert.equal(typeof result.ms, "number");
    assert.ok(result.ms >= 0, `implausible duration: ${result.ms}`);

    const record = await readFile(recordPath, "utf-8");
    assert.equal(record.trim(), "input=input.rtf");

    const sent = await readFile(inputCopyPath, "latin1");
    assert.ok(sent.startsWith("{\\rtf1"), `not RTF: ${sent.slice(0, 32)}`);
    // The generator hardcodes this face, so the warm-up has to exercise it.
    assert.match(sent, /Times New Roman/);
}

/**
 * The whole point of asserting the %PDF header: soffice exiting 0 having
 * written *something* must not be reported as a working converter. Without
 * this check the warm-up would restore the exact failure it exists to catch —
 * a startup log claiming success while conversion is broken.
 */
async function testNonPdfOutputIsNotOk(): Promise<void> {
    const binaryPath = await writeFakeSoffice(
        "soffice-not-a-pdf",
        ['echo "<html>error page</html>" > "$outdir/$stem.pdf"', "exit 0"].join(
            "\n",
        ),
    );

    const result = await warmUpLibreOffice({ binaryPath });

    assert.equal(result.ok, false);
    assert.equal(typeof result.ms, "number");
    assert.ok(
        result.ok === false && /%PDF/.test(result.error),
        `expected the header to be named in the error, got: ${
            result.ok === false ? result.error : "<ok>"
        }`,
    );
}

/**
 * A failed conversion must come back as a value, not a rejection: the caller is
 * the listen callback, where an unhandled rejection reads as a crash.
 */
async function testFailedConversionReportsNotOkWithoutThrowing(): Promise<void> {
    const binaryPath = await writeFakeSoffice(
        "soffice-broken",
        ['echo "Error: source file could not be loaded" >&2', "exit 3"].join(
            "\n",
        ),
    );

    const result = await warmUpLibreOffice({ binaryPath });

    assert.equal(result.ok, false);
    assert.ok(
        result.ok === false && result.error.length > 0,
        "a failure with no detail is useless in a startup log",
    );
    // The converter's error code is what says whether this is retryable.
    assert.ok(
        result.ok === false && /DOCUMENT_CONVERSION_FAILED/.test(result.error),
        `expected the converter code in the error, got: ${
            result.ok === false ? result.error : "<ok>"
        }`,
    );
}

/** No usable binary at all — the state a fontless/LibreOffice-less image is in. */
async function testMissingBinaryReportsNotOkWithoutThrowing(): Promise<void> {
    const result = await warmUpLibreOffice({
        binaryPath: path.join(scratchDir, "definitely-not-here"),
    });

    assert.equal(result.ok, false);
    assert.ok(
        result.ok === false &&
            /DOCUMENT_CONVERTER_UNAVAILABLE/.test(result.error),
        `expected an unavailable code, got: ${
            result.ok === false ? result.error : "<ok>"
        }`,
    );
}

/** A wedged soffice must be bounded, and must not escape as a rejection. */
async function testTimeoutReportsNotOkWithoutThrowing(): Promise<void> {
    const binaryPath = await writeFakeSoffice(
        "soffice-slow",
        // Redirect the sleep's stdio so it does not hold the pipes open after
        // the shell is killed — otherwise the callback waits for the orphan.
        ["sleep 3 </dev/null >/dev/null 2>&1", "exit 0"].join("\n"),
    );

    const result = await warmUpLibreOffice({ binaryPath, timeoutMs: 1_000 });

    assert.equal(result.ok, false);
    assert.ok(
        result.ok === false &&
            /DOCUMENT_CONVERSION_TIMEOUT/.test(result.error),
        `expected a timeout code, got: ${
            result.ok === false ? result.error : "<ok>"
        }`,
    );
}

/**
 * The kill switch. Default ON is the point — the warm-up is only worth having
 * if nobody has to remember to turn it on — but an operator watching the
 * container get OOM-killed has to be able to stop the boot-time soffice spawn
 * from the dashboard, so exactly one value disables it and junk never does.
 *
 * A pure function over an injected env, so no process.env mutation and no
 * ordering coupling with the conversion cases above.
 */
function testWarmUpEnabledFlag(): void {
    assert.equal(libreOfficeWarmupEnabled({}), true, "unset → warm-up runs");
    assert.equal(
        libreOfficeWarmupEnabled({ LIBREOFFICE_WARMUP_ENABLED: "" }),
        true,
        "blank (the .env.example default) → warm-up runs",
    );
    assert.equal(
        libreOfficeWarmupEnabled({ LIBREOFFICE_WARMUP_ENABLED: "true" }),
        true,
    );

    // The one value that disarms it, case-insensitively: a dashboard field is
    // as likely to be typed "False" as "false".
    assert.equal(
        libreOfficeWarmupEnabled({ LIBREOFFICE_WARMUP_ENABLED: "false" }),
        false,
    );
    assert.equal(
        libreOfficeWarmupEnabled({ LIBREOFFICE_WARMUP_ENABLED: "FALSE" }),
        false,
    );
    assert.equal(
        libreOfficeWarmupEnabled({ LIBREOFFICE_WARMUP_ENABLED: "False" }),
        false,
    );

    // Junk must not disarm it — silently losing the one signal that says
    // conversion works is worse than ignoring a typo.
    for (const junk of ["0", "off", "no", "disabled", " false "]) {
        assert.equal(
            libreOfficeWarmupEnabled({ LIBREOFFICE_WARMUP_ENABLED: junk }),
            true,
            `${JSON.stringify(junk)} must not disarm the warm-up`,
        );
    }
}

async function main(): Promise<void> {
    // The converter's concurrency gate is built once, lazily, from the
    // environment on the first conversion. Pin it to the default so a
    // developer's exported override cannot change what these tests mean.
    delete process.env.LIBREOFFICE_MAX_CONCURRENT;

    scratchDir = await mkdtemp(path.join(os.tmpdir(), "coco-lo-warmup-test-"));
    recordPath = path.join(scratchDir, "record.txt");
    inputCopyPath = path.join(scratchDir, "sent-input");
    try {
        await testSuccessfulWarmUpReportsOk();
        await testNonPdfOutputIsNotOk();
        await testFailedConversionReportsNotOkWithoutThrowing();
        await testMissingBinaryReportsNotOkWithoutThrowing();
        await testTimeoutReportsNotOkWithoutThrowing();
        testWarmUpEnabledFlag();
    } finally {
        await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    }
    console.log("libreofficeWarmup.test.ts: all passed");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
