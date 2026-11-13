import assert from "node:assert/strict";
import { resolveTimeZone, temporalGroundingLine } from "./temporalContext";

// Force a known firm default so fallback assertions are deterministic
// regardless of the ambient environment. resolveTimeZone reads the env at call
// time, so setting it here is enough.
process.env.CALENDAR_DEFAULT_TIMEZONE = "America/Chicago";

// Intl formats times with a NARROW NO-BREAK SPACE (U+202F) before AM/PM on
// modern ICU (Node 18+). JS `\s` matches it, so collapse all whitespace to a
// single ASCII space before substring assertions.
const norm = (s: string) => s.replace(/\s+/g, " ");

function testResolveTimeZone() {
    // Valid zones pass straight through.
    assert.equal(resolveTimeZone("America/New_York"), "America/New_York");
    assert.equal(resolveTimeZone("UTC"), "UTC");

    // Invalid / empty / missing fall back to the firm default.
    assert.equal(resolveTimeZone("Not/AZone"), "America/Chicago");
    assert.equal(resolveTimeZone(""), "America/Chicago");
    assert.equal(resolveTimeZone(undefined), "America/Chicago");
    assert.equal(resolveTimeZone(null), "America/Chicago");
    // A hostile string is rejected by Intl, never interpolated.
    assert.equal(
        resolveTimeZone("'; DROP TABLE events; --"),
        "America/Chicago",
    );
}

function testGroundingLineLocalZone() {
    // 21:34 UTC on 2026-07-17 → 14:34 PDT (UTC-7 in July) the SAME calendar day.
    const now = new Date("2026-07-17T21:34:00Z");
    const line = norm(
        temporalGroundingLine({ now, timeZone: "America/Los_Angeles" }),
    );

    assert.ok(
        line.includes("Friday, July 17, 2026"),
        `expected local date, got: ${line}`,
    );
    assert.ok(
        line.includes("2:34 PM PDT"),
        `expected local time+tz, got: ${line}`,
    );
    assert.ok(
        line.includes("(America/Los_Angeles)"),
        `expected IANA zone label, got: ${line}`,
    );
    assert.ok(
        line.includes("2026-07-17T21:34:00"),
        `expected UTC ISO instant, got: ${line}`,
    );
    assert.ok(
        line.includes('authoritative "now"'),
        "expected the authoritative-now instruction",
    );
}

function testGroundingLineShiftsDayAcrossZone() {
    // 02:00 UTC on 2026-07-17 → 19:00 PDT on 2026-07-16 (PREVIOUS day). Proves
    // the zone is actually applied rather than the string being taken from UTC.
    const now = new Date("2026-07-17T02:00:00Z");
    const line = norm(
        temporalGroundingLine({ now, timeZone: "America/Los_Angeles" }),
    );

    assert.ok(
        line.includes("Thursday, July 16, 2026"),
        `expected zone to shift the day back, got: ${line}`,
    );
    assert.ok(
        line.includes("7:00 PM PDT"),
        `expected 7:00 PM PDT, got: ${line}`,
    );
}

function testGroundingLineUtc() {
    const now = new Date("2026-07-17T21:34:00Z");
    const line = norm(temporalGroundingLine({ now, timeZone: "UTC" }));
    assert.ok(line.includes("Friday, July 17, 2026"), line);
    assert.ok(line.includes("(UTC)"), line);
}

function testGroundingLineFallsBackForBadZone() {
    // No zone supplied → firm default (America/Chicago).
    const now = new Date("2026-07-17T21:34:00Z");
    const line = norm(temporalGroundingLine({ now }));
    assert.ok(
        line.includes("(America/Chicago)"),
        `expected firm-default zone, got: ${line}`,
    );
}

function main() {
    testResolveTimeZone();
    testGroundingLineLocalZone();
    testGroundingLineShiftsDayAcrossZone();
    testGroundingLineUtc();
    testGroundingLineFallsBackForBadZone();
    console.log("systemPrompt/temporalContext.test.ts: all passed");
}

main();
