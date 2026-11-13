"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { API_BASE } from "@/app/lib/apiBase";

/**
 * Fetch a generated document artifact (image png / voice-briefing mp3) as an
 * authenticated blob and expose it as an object URL — the DocDownloadBlock /
 * useFetchSingleDoc pattern: bearer-token fetch of `/single-documents/:id/display`
 * → `URL.createObjectURL`, revoked on unmount/change. `/display` serves these
 * artifacts as `application/octet-stream` (mimeForExtension has no mp3/png
 * entry), so `mimeOverride` re-types the blob when set (e.g. "audio/mpeg" so
 * `<audio>` plays; images render from octet-stream fine, so it's optional).
 *
 * Shared by the recordings extras cards and the chat GeneratedImageCard.
 */
export function useDocumentObjectUrl(
    documentId: string | null,
    mimeOverride?: string,
): { url: string | null; loading: boolean; error: string | null } {
    const [url, setUrl] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!documentId) {
            setUrl(null);
            setError(null);
            setLoading(false);
            return;
        }
        let cancelled = false;
        let objectUrl: string | null = null;
        setLoading(true);
        setError(null);
        (async () => {
            try {
                const {
                    data: { session },
                } = await supabase.auth.getSession();
                const token = session?.access_token;
                const resp = await fetch(
                    `${API_BASE}/single-documents/${documentId}/display`,
                    {
                        headers: token
                            ? { Authorization: `Bearer ${token}` }
                            : {},
                    },
                );
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const raw = await resp.blob();
                const blob =
                    mimeOverride && !raw.type.startsWith(mimeOverride.split("/")[0])
                        ? new Blob([raw], { type: mimeOverride })
                        : raw;
                if (cancelled) return;
                objectUrl = URL.createObjectURL(blob);
                setUrl(objectUrl);
            } catch {
                if (!cancelled) setError("Could not load this file.");
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [documentId, mimeOverride]);

    return { url, loading, error };
}
