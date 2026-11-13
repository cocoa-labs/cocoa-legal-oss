// backend/src/lib/calendar/deadlines.ts
//
// Legal-deadline classification for the create_deadline tool. Given a deadline's
// text (and optional overrides), pick the deadline TYPE and a default reminder
// lead time. Pure + deterministic so it is unit-testable and never surprises the
// user; the model can always override the guess by passing an explicit type or
// lead time.
import type { DeadlineType } from "./types";

/** Default days-before-due to remind, by deadline type. */
export const DEADLINE_LEAD_DAYS: Record<DeadlineType, number> = {
    statute_of_limitations: 30,
    filing: 10,
    court_date: 7,
    other: 3,
};

// Ordered most-specific-first: a statute reference should win over a generic
// "file" mention in the same sentence.
const KEYWORDS: { type: DeadlineType; patterns: RegExp[] }[] = [
    {
        type: "statute_of_limitations",
        patterns: [/statute of limitation/i, /\bsol\b/i, /limitations period/i],
    },
    {
        type: "court_date",
        patterns: [
            /\bhearing\b/i,
            /\btrial\b/i,
            /\bdeposition\b/i,
            /\bconference\b/i,
            /\barraignment\b/i,
            /\boral argument\b/i,
            /\bcourt appearance\b/i,
        ],
    },
    {
        type: "filing",
        patterns: [
            /\bfil(e|ing)\b/i,
            /\bdue\b/i,
            /\bdeadline\b/i,
            /\bsubmit\b/i,
            /\bresponse\b/i,
            /\banswer\b/i,
        ],
    },
];

/**
 * Classify a deadline from its text, honoring explicit overrides. Returns the
 * chosen type and the lead time (days before the due date) to remind.
 */
export function classifyDeadline(input: {
    text: string;
    explicitType?: DeadlineType | null;
    explicitLeadDays?: number | null;
}): { type: DeadlineType; leadDays: number } {
    const type =
        input.explicitType ?? guessType(input.text ?? "");
    const leadDays =
        typeof input.explicitLeadDays === "number" && input.explicitLeadDays > 0
            ? Math.trunc(input.explicitLeadDays)
            : DEADLINE_LEAD_DAYS[type];
    return { type, leadDays };
}

function guessType(text: string): DeadlineType {
    for (const { type, patterns } of KEYWORDS) {
        if (patterns.some((re) => re.test(text))) return type;
    }
    return "other";
}
