// backend/src/lib/automation/rehearsalFixtures.ts
//
// Loader + validator for the PI rollout-kit fixtures in backend/fixtures/pi
// — the 100% synthetic inbound emails (ParsedEmail-shaped JSON) and PDFs the
// rehearsal script (scripts/rehearsePipeline.ts) drives through the REAL
// pipeline, and the expected outcome each fixture should reach. Shared by
// the rehearsal script and the fixture-validation test
// (rehearsalFixtures.test.ts) so the fixture contract cannot drift between
// them. Everything here is pure fs/path — no Supabase, no LLM, no network.
//
// Fixture rules (see fixtures/pi/README.md): every person, claim number,
// policy number, invoice number, and amount is invented; carrier/vendor
// names come from the public registries seeded by migration 024. An
// attachment's `attachmentId` doubles as its filename in the fixtures
// directory — the rehearsal script reads the PDF bytes from disk where
// production ingest would call connector.getAttachment.

import fs from "node:fs";
import path from "node:path";

import type {
    ParsedEmail,
    ParsedEmailAttachment,
} from "../connectors/types";
import type { WorkflowKind } from "./types";

/** backend/fixtures/pi, resolved relative to this module (cwd-independent). */
export const PI_FIXTURES_DIR = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "fixtures",
    "pi",
);

/** The five inbound-email fixtures (basename without .json). */
export const FIXTURE_EMAIL_NAMES = [
    "claim-email-1",
    "claim-email-2",
    "invoice-email-1",
    "invoice-email-2",
    "nonmatch-email",
] as const;

export type FixtureEmailName = (typeof FIXTURE_EMAIL_NAMES)[number];

/** The checked-in PDFs generateFixturePdfs.ts produces. */
export const FIXTURE_PDF_NAMES = ["dec-page.pdf", "invoice.pdf"] as const;

/**
 * The two synthetic cases the rehearsal script seeds (via the SAME
 * upsertCaseFromImport path the CSV import wizard uses) so the fixtures
 * have real cases to match against. Case numbers are PI-TEST-prefixed so
 * they are unmistakable — and easy to find and delete — in a shared dev
 * workspace.
 */
export const REHEARSAL_CASES = [
    {
        caseNumber: "PI-TEST-0001",
        clientName: "Jordan Sample",
        dateOfLoss: "2026-03-14",
    },
    {
        caseNumber: "PI-TEST-0002",
        clientName: "Casey Example",
        dateOfLoss: "2026-01-27",
    },
] as const;

export interface FixtureExpectation {
    /** Expected classification (null = the classifier should skip). */
    kind: WorkflowKind | null;
    /** Expected terminal run status for a healthy rehearsal. */
    status: "staged" | "skipped";
    /** Claims the extraction must contain at least (multi-claim fixtures). */
    minClaims?: number;
    /** One-line description of what the fixture exercises. */
    exercises: string;
}

/**
 * What each fixture should do to a healthy dev environment (migrations
 * 023/024 applied, rehearsal cases seeded). The rehearsal script judges its
 * PASS/FAIL lines against this map; fixtures/pi/README.md narrates the
 * same outcomes in prose.
 */
export const FIXTURE_EXPECTATIONS: Record<FixtureEmailName, FixtureExpectation> =
    {
        "claim-email-1": {
            kind: "claim_correspondence",
            status: "staged",
            exercises:
                "carrier-domain classification + dec-page PDF extraction + name/DOL case match + staged policy upsert & ack draft",
        },
        "claim-email-2": {
            kind: "claim_correspondence",
            status: "staged",
            minClaims: 2,
            exercises:
                "policy-limits demand with a response deadline + TWO claim numbers in one letter (multi-claim edge), body-only extraction",
        },
        "invoice-email-1": {
            kind: "vendor_invoice",
            status: "staged",
            exercises:
                "vendor-domain classification + invoice PDF extraction + matter-reference case match + staged pending expense",
        },
        "invoice-email-2": {
            kind: "vendor_invoice",
            status: "staged",
            exercises:
                "records-vendor invoice with a client-name matter reference, body-only extraction",
        },
        "nonmatch-email": {
            kind: null,
            status: "skipped",
            exercises:
                "cold email matching no registry and carrying no PDF — deterministic skip, zero LLM calls",
        },
    };

function fail(path_: string, expected: string): never {
    throw new Error(`${path_}: expected ${expected}`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseString(v: unknown, path_: string): string {
    if (typeof v !== "string") fail(path_, "a string");
    return v;
}

function parseNonEmptyString(v: unknown, path_: string): string {
    const s = parseString(v, path_);
    if (!s.trim()) fail(path_, "a non-empty string");
    return s;
}

function parseNullableString(v: unknown, path_: string): string | null {
    if (v === null) return null;
    return parseString(v, `${path_}`);
}

function parseOptionalNullableString(
    v: unknown,
    path_: string,
): string | null | undefined {
    if (v === undefined) return undefined;
    return parseNullableString(v, path_);
}

function parseStringArray(v: unknown, path_: string): string[] {
    if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) {
        fail(path_, "an array of strings");
    }
    return v as string[];
}

function parseAttachment(v: unknown, path_: string): ParsedEmailAttachment {
    if (!isPlainObject(v)) fail(path_, "an object");
    const size = v.size;
    if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
        fail(`${path_}.size`, "a non-negative number");
    }
    return {
        attachmentId: parseNonEmptyString(v.attachmentId, `${path_}.attachmentId`),
        filename: parseNonEmptyString(v.filename, `${path_}.filename`),
        contentType: parseNonEmptyString(v.contentType, `${path_}.contentType`),
        size,
    };
}

/**
 * Strictly validate a fixture JSON value as a ParsedEmail (the exact shape
 * the Gmail connector's getMessage returns — lib/connectors/types.ts).
 * Same discipline as the parsers in automation/types.ts: throw a
 * path-prefixed Error on the first violation, and build a FRESH object so
 * unknown keys are dropped.
 */
export function parseParsedEmailFixture(
    value: unknown,
    label: string,
): ParsedEmail {
    if (!isPlainObject(value)) fail(label, "a JSON object");
    const v = value;
    const attachmentsRaw = v.attachments;
    if (!Array.isArray(attachmentsRaw)) fail(`${label}.attachments`, "an array");
    const email: ParsedEmail = {
        id: parseNonEmptyString(v.id, `${label}.id`),
        threadId: parseNonEmptyString(v.threadId, `${label}.threadId`),
        from: parseNonEmptyString(v.from, `${label}.from`),
        to: parseStringArray(v.to, `${label}.to`),
        cc: parseStringArray(v.cc, `${label}.cc`),
        subject: parseString(v.subject, `${label}.subject`),
        date: parseNullableString(v.date, `${label}.date`),
        snippet: parseString(v.snippet, `${label}.snippet`),
        bodyText: parseString(v.bodyText, `${label}.bodyText`),
        bodyHtml: parseNullableString(v.bodyHtml, `${label}.bodyHtml`),
        messageIdHeader: parseNullableString(
            v.messageIdHeader,
            `${label}.messageIdHeader`,
        ),
        inReplyTo: parseNullableString(v.inReplyTo, `${label}.inReplyTo`),
        references: parseStringArray(v.references, `${label}.references`),
        labelIds: parseStringArray(v.labelIds, `${label}.labelIds`),
        attachments: attachmentsRaw.map((a, i) =>
            parseAttachment(a, `${label}.attachments[${i}]`),
        ),
    };
    if (v.historyId !== undefined) {
        email.historyId = parseNonEmptyString(v.historyId, `${label}.historyId`);
    }
    const autoSubmitted = parseOptionalNullableString(
        v.autoSubmitted,
        `${label}.autoSubmitted`,
    );
    if (autoSubmitted !== undefined) email.autoSubmitted = autoSubmitted;
    const precedence = parseOptionalNullableString(
        v.precedence,
        `${label}.precedence`,
    );
    if (precedence !== undefined) email.precedence = precedence;
    const listId = parseOptionalNullableString(v.listId, `${label}.listId`);
    if (listId !== undefined) email.listId = listId;
    const listUnsubscribe = parseOptionalNullableString(
        v.listUnsubscribe,
        `${label}.listUnsubscribe`,
    );
    if (listUnsubscribe !== undefined) email.listUnsubscribe = listUnsubscribe;
    return email;
}

export interface LoadedEmailFixture {
    name: FixtureEmailName;
    email: ParsedEmail;
    /** attachmentId → absolute path of the checked-in PDF bytes. */
    attachmentPaths: Map<string, string>;
    expectation: FixtureExpectation;
}

/**
 * Load one email fixture from backend/fixtures/pi: parse + validate the
 * JSON as a ParsedEmail and resolve every attachment to its on-disk file.
 * Throws with an actionable message when the JSON is malformed or a
 * referenced PDF has not been generated yet.
 */
export function loadEmailFixture(name: FixtureEmailName): LoadedEmailFixture {
    const jsonPath = path.join(PI_FIXTURES_DIR, `${name}.json`);
    if (!fs.existsSync(jsonPath)) {
        throw new Error(`fixture missing: ${jsonPath}`);
    }
    let raw: unknown;
    try {
        raw = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    } catch (err) {
        throw new Error(
            `${name}.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
    const email = parseParsedEmailFixture(raw, name);
    const attachmentPaths = new Map<string, string>();
    for (const att of email.attachments) {
        const pdfPath = path.join(PI_FIXTURES_DIR, att.filename);
        if (!fs.existsSync(pdfPath)) {
            throw new Error(
                `${name}.json references attachment "${att.filename}" but ${pdfPath} does not exist — run: npx tsx scripts/generateFixturePdfs.ts`,
            );
        }
        attachmentPaths.set(att.attachmentId, pdfPath);
    }
    return { name, email, attachmentPaths, expectation: FIXTURE_EXPECTATIONS[name] };
}
