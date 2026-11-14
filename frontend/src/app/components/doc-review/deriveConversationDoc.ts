import type { CocoaLegalChat, CocoaLegalMessage } from "@/app/components/shared/types";

export interface ConversationDoc {
    documentId: string;
    versionId: string | null;
    versionNumber: number | null;
}

// The document an assistant turn was working on: the last doc it
// read / edited / created (these events carry document_id once persisted).
function agentFocusDocId(events: CocoaLegalMessage["events"]): string | null {
    if (!events) return null;
    for (let j = events.length - 1; j >= 0; j--) {
        const e = events[j];
        if (
            e.type === "doc_edited" ||
            e.type === "doc_created" ||
            e.type === "doc_read"
        ) {
            const id = (e as { document_id?: string }).document_id;
            if (typeof id === "string" && id) return id;
        }
    }
    return null;
}

/**
 * The document (and version) a conversation is "about" — used to keep the
 * viewer in sync with the chat instead of auto-opening the first project doc.
 *
 * Scans messages newest-first and returns the most recent document the
 * conversation engaged, considering BOTH:
 *   - the agent's focus this turn (the last doc it read / edited / created), and
 *   - the doc the user was viewing when they sent the turn (version_context).
 * The agent's focus wins when it's the more recent signal, so the viewer
 * follows what the assistant is actually working on (e.g. it read 03) rather
 * than a stale anchor. Falls back to the chat's fork anchor, else null.
 *
 * IMPORTANT: callers must NOT fall back to "first project doc" when this
 * returns null — doing so is what made the viewer snap to doc 01.
 *
 * External types are imported type-only so this module has no runtime imports
 * and can be unit-tested directly with `tsx`.
 */
export function deriveConversationDoc(
    messages: Pick<CocoaLegalMessage, "version_context" | "events">[],
    chat?: Pick<CocoaLegalChat, "anchor_document_id" | "anchor_version_id"> | null,
): ConversationDoc | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];

        // (a) The agent's doc focus this turn (assistant messages).
        const focusId = agentFocusDocId(m?.events);
        if (focusId) {
            return { documentId: focusId, versionId: null, versionNumber: null };
        }

        // (b) The doc the user was viewing when they sent this turn.
        const vc = m?.version_context;
        const anchoredId = vc?.anchored_document_id;
        if (anchoredId) {
            const entry =
                vc?.docs?.find((d) => d.document_id === anchoredId) ??
                vc?.docs?.find((d) => d.displayed) ??
                null;
            return {
                documentId: anchoredId,
                versionId: entry?.version_id ?? null,
                versionNumber: entry?.version_number ?? null,
            };
        }
    }

    if (chat?.anchor_document_id) {
        return {
            documentId: chat.anchor_document_id,
            versionId: chat.anchor_version_id ?? null,
            versionNumber: null,
        };
    }

    return null;
}
