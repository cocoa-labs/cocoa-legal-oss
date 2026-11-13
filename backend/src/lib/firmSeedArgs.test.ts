import assert from "node:assert/strict";
import { parseFirmSeedArgs } from "./firmSeedArgs";

function testDefaultsMatchMigration027() {
    assert.deepEqual(parseFirmSeedArgs([]), {
        name: "My Firm",
        slug: "pilot-firm",
        admins: [],
        allowed: [],
        apply: false,
    });
}

function testAdminsAreNormalizedAndMergedIntoAllowed() {
    assert.deepEqual(
        parseFirmSeedArgs([
            "--admin",
            "Owner@Example.com",
            "--allow",
            "a@example.com,owner@example.com",
            "--apply",
        ]),
        {
            name: "My Firm",
            slug: "pilot-firm",
            admins: ["owner@example.com"],
            allowed: ["owner@example.com", "a@example.com"],
            apply: true,
        },
    );
}

function testNameAndSlugOverrides() {
    const config = parseFirmSeedArgs(["--name", "Example Law LLP", "--slug", "example-law"]);
    assert.equal(config.name, "Example Law LLP");
    assert.equal(config.slug, "example-law");
    assert.equal(config.apply, false, "a dry run unless --apply is passed");
}

function testRejectsUnknownFlagsMissingValuesAndBadEmails() {
    assert.throws(() => parseFirmSeedArgs(["--bogus"]), /unknown flag/i);
    assert.throws(() => parseFirmSeedArgs(["--name"]), /missing value/i);
    assert.throws(() => parseFirmSeedArgs(["--admin", "--apply"]), /missing value/i);
    assert.throws(() => parseFirmSeedArgs(["--allow", "not-an-email"]), /email/i);
}

testDefaultsMatchMigration027();
testAdminsAreNormalizedAndMergedIntoAllowed();
testNameAndSlugOverrides();
testRejectsUnknownFlagsMissingValuesAndBadEmails();
console.log("firmSeedArgs.test.ts: all passed");
