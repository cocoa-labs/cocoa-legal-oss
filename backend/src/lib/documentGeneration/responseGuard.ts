const MARKERS = [
    "[document_job_started action]",
    "[document_job_status action]",
];

/** Incremental filter: control records belong to server events, never prose. */
export function createDocumentActionFilter(
    onMarker: (jobId: string | null) => void,
) {
    let pending = "";
    const drain = (final: boolean) => {
        let output = "";
        while (pending) {
            const positions = MARKERS.map((marker) => ({
                marker,
                at: pending.indexOf(marker),
            }))
                .filter((match) => match.at >= 0)
                .sort((a, b) => a.at - b.at);
            const match = positions[0];
            if (!match) {
                let keep = 0;
                if (!final)
                    for (const marker of MARKERS) {
                        for (let n = 1; n < marker.length; n++) {
                            if (pending.endsWith(marker.slice(0, n)))
                                keep = Math.max(keep, n);
                        }
                    }
                output += pending.slice(0, pending.length - keep);
                pending = pending.slice(pending.length - keep);
                break;
            }
            output += pending.slice(0, match.at);
            pending = pending.slice(match.at);
            const after = pending.slice(match.marker.length);
            const whitespace = after.length - after.trimStart().length;
            const json = after.slice(whitespace);
            if (!json && !final) break;
            let end = 0;
            if (json.startsWith("{")) {
                let depth = 0,
                    quoted = false,
                    escaped = false;
                for (let i = 0; i < json.length; i++) {
                    const char = json[i];
                    if (escaped) {
                        escaped = false;
                        continue;
                    }
                    if (quoted && char === "\\") {
                        escaped = true;
                        continue;
                    }
                    if (char === '"') {
                        quoted = !quoted;
                        continue;
                    }
                    if (quoted) continue;
                    if (char === "{") depth++;
                    if (char === "}" && --depth === 0) {
                        end = i + 1;
                        break;
                    }
                }
                if (!end && !final) break;
                if (!end) end = json.length;
            }
            let jobId: string | null = null;
            try {
                const record = JSON.parse(json.slice(0, end));
                if (typeof record.job_id === "string") jobId = record.job_id;
            } catch {
                /* Malformed control records are also suppressed. */
            }
            onMarker(jobId);
            pending = after.slice(whitespace + end);
        }
        return output;
    };
    return {
        push(delta: string) {
            pending += delta;
            return drain(false);
        },
        finish() {
            return drain(true);
        },
    };
}

export function normalizeDocumentActionProse(text: string) {
    const filter = createDocumentActionFilter(() => {});
    return filter.push(text) + filter.finish();
}

/** Only the current, direct user message can select continuation behavior. */
export function isDocumentProgressRequest(text: string) {
    if (
        text.length > 500 ||
        /\b(create|write|add|new|another|additional|instead|change|revise)\b/i.test(
            text,
        ) ||
        /^\s*(?:please\s+)?draft\b/i.test(text)
    )
        return false;
    return (
        /\b(continue|resume|keep going|(?:finish|complete) (?:it|them|this|that|(?:the|this|existing) (?:packet|documents?|draft))|are you (?:done|finished)|still (?:building|working|drafting))\b/i.test(
            text,
        ) ||
        (/\b(status|progress)\b/i.test(text) &&
            /\b(documents?|packet|drafts?|job)\b/i.test(text))
    );
}

export function hasUnverifiedDocumentClaim(
    text: string,
    markerIds: (string | null)[],
    scheduledIds: ReadonlySet<string>,
) {
    if (markerIds.some((id) => !id || !scheduledIds.has(id))) return true;
    if (scheduledIds.size) return false;
    // Catch affirmative acknowledgements even if the model omits its marker.
    return (
        /\b(?:I(?:['’]ve| have)?|we(?:['’]ve| have)?)\s+(?:just\s+)?(?:queued|scheduled|started)\b[^.!?\n]{0,150}\b(?:documents?|memos?|memorand\w*|packet|drafts?)\b/i.test(
            text,
        ) || /\bwhat I(?:['’]ve| have) (?:queued|scheduled)\b/i.test(text)
    );
}
