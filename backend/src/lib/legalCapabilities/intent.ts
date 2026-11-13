// backend/src/lib/legalCapabilities/intent.ts
import { allCapabilities } from "./index";

/**
 * Lightweight signal a route can build cheaply from the current turn:
 * the user's message text plus any attachment filenames. We keep intent
 * detection deterministic/lexical in v1 (no LLM classifier) — see
 * IntentSignals in types.ts.
 */
export interface MessageIntentInput {
    /** The user's latest message text (may be empty). */
    text?: string | null;
    /** Attachment filenames on the latest message (document/image). */
    filenames?: string[];
}

/**
 * Normalize a string for phrase matching: lowercase, and collapse common
 * filename separators (underscores, hyphens, dots) and runs of whitespace to
 * single spaces. This lets a filename like "Office_Lease_2026.pdf" match the
 * phrase "office lease". Shared by the matcher below AND the upload
 * classifier (creClassifier.ts re-exports it), so the router, the playbook
 * key-selector, and the classifier all normalize identically — the single
 * point that prevents filename-matching divergence across the three.
 */
export function normalizeForMatch(value: string): string {
    return value
        .toLowerCase()
        .replace(/[_\-.]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * A normalized phrase needs WORD-BOUNDARY matching (rather than plain
 * substring) when it is short enough to collide with the inside of unrelated
 * words. Short, single-token acronyms like "psa", "cam", and "snda" otherwise
 * fire as substrings inside "psalm", "campaign", "decampment", etc. We treat a
 * phrase as boundary-sensitive iff, after normalization, it is a single token
 * (no internal space) of at most {@link BOUNDARY_MATCH_MAX_LEN} characters —
 * which is exactly the set of short alphabetic acronyms in our vocabulary
 * (psa/cam/snda/rofr/rofo). Longer single-word phrases (e.g. "subordination",
 * "estoppel") and all multi-word phrases (e.g. "commercial lease", "purchase
 * and sale agreement") stay on substring matching, so normalized separators
 * still let a filename like "Office_Commercial_Lease.pdf" match
 * "commercial lease". Dependency-free and deterministic.
 */
const BOUNDARY_MATCH_MAX_LEN = 4;

function phraseNeedsBoundary(normalizedPhrase: string): boolean {
    return (
        normalizedPhrase.length <= BOUNDARY_MATCH_MAX_LEN &&
        !normalizedPhrase.includes(" ")
    );
}

/**
 * True if the already-normalized phrase occurs in the already-normalized,
 * space-delimited haystack. Short/acronym phrases (see
 * {@link phraseNeedsBoundary}) must appear as a WHOLE token — flanked by a
 * space or a string boundary — so "psa" matches "review the psa" / "psa.pdf"
 * but not "psalm" or "gypsam". Other phrases use substring matching, which is
 * what lets multi-word phrases span normalized separators.
 */
function phraseMatchesHaystack(normPhrase: string, normHaystack: string): boolean {
    if (phraseNeedsBoundary(normPhrase)) {
        const re = new RegExp(
            `(^|\\s)${escapeForRegExp(normPhrase)}(\\s|$)`,
        );
        return re.test(normHaystack);
    }
    return normHaystack.includes(normPhrase);
}

/** Escape RegExp metacharacters so a phrase is matched literally. */
function escapeForRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The shared phrase-matching primitive used by BOTH the playbook
 * key-selector (below) and the chat intent router (legalIntentRouter.ts), and
 * re-exported via {@link matchesAnyPhrase} for the upload classifier
 * (creClassifier.ts). Keeping a single matcher here means every consumer
 * shares one definition of "does this phrase appear" — they can never diverge
 * on case-handling, normalization, or substring-vs-boundary semantics.
 *
 * Returns the number of DISTINCT phrases from `phrases` that occur in ANY
 * normalized haystack string. Phrases are normalized the same way as haystacks
 * (so a hint like "lease-agreement" matches a filename
 * "Office-Lease-Agreement.pdf"). Short/acronym phrases match only on a word
 * boundary (see {@link phraseMatchesHaystack}); longer/multi-word phrases use
 * substring matching. Empty phrases/haystacks are ignored. Counting distinct
 * phrases (not total occurrences) keeps the router's scoring stable regardless
 * of how many attachments repeat the same hint.
 */
export function countPhraseHits(
    phrases: readonly string[],
    haystacks: readonly string[],
): number {
    const normHaystacks = haystacks
        .map((h) => normalizeForMatch(h ?? ""))
        .filter((h) => h.length > 0);
    if (normHaystacks.length === 0) return 0;

    let hits = 0;
    for (const phrase of phrases) {
        const p = normalizeForMatch(phrase ?? "");
        if (!p) continue;
        if (normHaystacks.some((h) => phraseMatchesHaystack(p, h))) hits += 1;
    }
    return hits;
}

/** Convenience boolean wrapper over {@link countPhraseHits}. */
export function matchesAnyPhrase(
    phrases: readonly string[],
    haystacks: readonly string[],
): boolean {
    return countPhraseHits(phrases, haystacks) > 0;
}

function matchesCapabilitySignals(
    input: MessageIntentInput,
    keywords: string[],
    documentHints: string[],
): boolean {
    const haystackText = input.text ?? "";
    const haystackNames = input.filenames ?? [];

    // Keyword signals match against the message text; document-hint signals
    // match against attachment filenames. (The richer router also scans
    // extracted body text + the persisted document_type slug.)
    return (
        matchesAnyPhrase(keywords, [haystackText]) ||
        matchesAnyPhrase(documentHints, haystackNames)
    );
}

/** The capabilities a turn should steer on, and their playbook keys. */
export interface RelevantCapabilities {
    /** Registered capability ids, in registration order. */
    ids: string[];
    /** Deduped union of those capabilities' playbookKeys, same order. */
    keys: string[];
}

/**
 * Determine which registered capabilities are contextually relevant for a
 * chat turn by inspecting every capability's intentSignals — the same
 * one-hit rule {@link selectRelevantPlaybookKeys} has always used (a
 * keyword in the message text OR a document hint in an attachment
 * filename). `opts.forceIds` additionally pulls in named capabilities that
 * did not match on signals — that is how a "capability run" turn steers on
 * exactly the capability the user confirmed. Unknown ids are ignored, so a
 * stale id from an older client can never inject anything.
 *
 * Purely registry-driven: with an empty registry (today's prod) it returns
 * `{ids: [], keys: []}`, and it lights up automatically as capabilities
 * register. Iterating the registry once means both arrays come back in
 * registration order, matched and forced capabilities alike.
 */
export function selectRelevantCapabilities(
    input: MessageIntentInput,
    opts?: { forceIds?: readonly string[] },
): RelevantCapabilities {
    const forced = new Set(opts?.forceIds ?? []);
    const ids: string[] = [];
    const keys = new Set<string>();
    for (const cap of allCapabilities()) {
        const { keywords, document_hints } = cap.intentSignals;
        const relevant =
            forced.has(cap.id) ||
            matchesCapabilitySignals(input, keywords, document_hints);
        if (!relevant) continue;
        ids.push(cap.id);
        for (const key of cap.playbookKeys) keys.add(key);
    }
    return { ids, keys: [...keys] };
}

/**
 * The playbook keys relevant to a chat turn: the deduped union of
 * `playbookKeys` across every capability whose signals match the
 * message/attachments. Thin wrapper over
 * {@link selectRelevantCapabilities} — kept because callers that only need
 * keys (and never force a capability) read better this way.
 */
export function selectRelevantPlaybookKeys(
    input: MessageIntentInput,
): string[] {
    return selectRelevantCapabilities(input).keys;
}
