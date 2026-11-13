import assert from "node:assert/strict";

import { MAX_CHAT_SEARCH_LENGTH, normalizeChatSearch } from "./chat";

// GET /chat's optional `search` param. The route applies the result as a
// standalone `.ilike("title", "%term%")` chained AFTER the scoping `.or(...)`,
// so these tests pin the only logic that isn't Supabase's: what counts as a
// usable term.

function test(name: string, fn: () => void) {
    fn();
    console.log(`  ✓ ${name}`);
}

console.log("normalizeChatSearch");

test("returns null when the param is absent", () => {
    assert.equal(normalizeChatSearch(undefined), null);
});

test("returns null for non-string params (?search=a&search=b)", () => {
    assert.equal(normalizeChatSearch(["a", "b"]), null);
    assert.equal(normalizeChatSearch({ bad: true }), null);
    assert.equal(normalizeChatSearch(7), null);
});

test("returns null for empty / whitespace-only terms", () => {
    // A `%%` match would be a no-op filter, so the route must skip it
    // entirely rather than run it.
    assert.equal(normalizeChatSearch(""), null);
    assert.equal(normalizeChatSearch("   "), null);
    assert.equal(normalizeChatSearch("\t\n "), null);
});

test("trims surrounding whitespace", () => {
    assert.equal(normalizeChatSearch("  Acme lease  "), "Acme lease");
});

test("caps the term length", () => {
    const long = "x".repeat(MAX_CHAT_SEARCH_LENGTH + 50);
    const out = normalizeChatSearch(long);
    assert.equal(out?.length, MAX_CHAT_SEARCH_LENGTH);
    assert.equal(out, "x".repeat(MAX_CHAT_SEARCH_LENGTH));
});

test("caps AFTER trimming, so padding doesn't eat the term", () => {
    const padded = `   ${"y".repeat(MAX_CHAT_SEARCH_LENGTH)}   `;
    assert.equal(normalizeChatSearch(padded), "y".repeat(MAX_CHAT_SEARCH_LENGTH));
});

test("passes PostgREST-ish punctuation through untouched", () => {
    // The term goes into its own .ilike() call, never into the .or() filter
    // string, so there is no delimiter to escape. `%`/`_` only widen the
    // user's match across their own chats.
    assert.equal(normalizeChatSearch("100% of it"), "100% of it");
    assert.equal(normalizeChatSearch("a_b"), "a_b");
    assert.equal(normalizeChatSearch("Smith, John"), "Smith, John");
    assert.equal(normalizeChatSearch("v.(Acme)"), "v.(Acme)");
});

console.log("chat.search tests passed");
