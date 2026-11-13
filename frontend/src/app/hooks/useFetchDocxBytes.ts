"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { API_BASE } from "@/app/lib/apiBase";

export interface FetchDocxResult {
    bytes: ArrayBuffer | null;
    downloadUrl: string | null;
    loading: boolean;
    error: string | null;
}

// Module-level cache keyed by `${documentId}:${versionId}:${refetchKey}`.
// The same cache is shared across every hook instance so tab switches
// (which remount new DocxView subtrees or re-run the effect because of an
// unstable prop upstream) don't cause a refetch as long as the tuple is
// unchanged. Promises are cached too, so concurrent mounts for the same
// key share a single in-flight request.
const bytesCache = new Map<string, ArrayBuffer>();
const inFlight = new Map<string, Promise<ArrayBuffer>>();

function cacheKey(
    documentId: string,
    versionId?: string | null,
    refetchKey?: number,
): string {
    return `${documentId}:${versionId ?? ""}:${refetchKey ?? ""}`;
}

function docxUrl(documentId: string, versionId?: string | null): string {
    const qs = versionId ? `?version_id=${encodeURIComponent(versionId)}` : "";
    return `${API_BASE}/single-documents/${documentId}/docx${qs}`;
}

/**
 * Fetch the raw .docx bytes for a document, optionally targeting a specific
 * tracked-changes version. Results are cached so the DocxView can re-render
 * cheaply when switching between versions, and tab switches don't refetch.
 */
export function useFetchDocxBytes(
    documentId: string | null | undefined,
    versionId?: string | null,
    refetchKey?: number,
): FetchDocxResult {
    const initialKey = documentId
        ? cacheKey(documentId, versionId, refetchKey)
        : null;
    const cachedBytes = initialKey ? (bytesCache.get(initialKey) ?? null) : null;
    const currentDownloadUrl = documentId ? docxUrl(documentId, versionId) : null;
    const [bytes, setBytes] = useState<ArrayBuffer | null>(
        cachedBytes,
    );
    const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    console.log("[useFetchDocxBytes] init", {
        documentId,
        versionId,
        refetchKey,
        initialKey,
        cacheHit: initialKey ? bytesCache.has(initialKey) : null,
    });

    useEffect(() => {
        if (!documentId) return;

        const key = cacheKey(documentId, versionId, refetchKey);
        const url = docxUrl(documentId, versionId);

        // Cache hit: reuse bytes synchronously, no network, no spinner.
        const cached = bytesCache.get(key);
        if (cached) return;

        let cancelled = false;
        queueMicrotask(() => {
            if (cancelled) return;
            setLoading(true);
            setError(null);
        });

        const pending =
            inFlight.get(key) ??
            (async () => {
                const {
                    data: { session },
                } = await supabase.auth.getSession();
                const token = session?.access_token;
                // Stream bytes through the backend (avoids CORS on R2
                // signed URLs). Retry on 429 (rate limit) with backoff so a
                // transient burst — e.g. accepting many tracked changes —
                // self-heals instead of dead-ending the preview.
                const maxAttempts = 3;
                let lastStatus = 0;
                for (let attempt = 0; attempt < maxAttempts; attempt++) {
                    const bin = await fetch(url, {
                        headers: token
                            ? { Authorization: `Bearer ${token}` }
                            : {},
                    });
                    if (bin.ok) {
                        const buf = await bin.arrayBuffer();
                        bytesCache.set(key, buf);
                        return buf;
                    }
                    lastStatus = bin.status;
                    if (bin.status === 429 && attempt < maxAttempts - 1) {
                        const retryAfter = Number(
                            bin.headers.get("retry-after"),
                        );
                        const delayMs =
                            Number.isFinite(retryAfter) && retryAfter > 0
                                ? retryAfter * 1000
                                : 800 * (attempt + 1);
                        await new Promise((r) => setTimeout(r, delayMs));
                        continue;
                    }
                    break;
                }
                throw new Error(
                    lastStatus === 429
                        ? "Too many requests — waiting a moment, please retry shortly."
                        : `HTTP ${lastStatus}`,
                );
            })();
        if (!inFlight.has(key)) inFlight.set(key, pending);

        pending
            .then((buf) => {
                if (cancelled) return;
                setBytes(buf);
                setDownloadUrl(url);
            })
            .catch((e: unknown) => {
                if (cancelled) return;
                setError(e instanceof Error ? e.message : String(e));
            })
            .finally(() => {
                inFlight.delete(key);
                if (!cancelled) setLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [documentId, versionId, refetchKey]);

    if (!documentId) {
        return { bytes: null, downloadUrl: null, loading: false, error: null };
    }

    if (cachedBytes) {
        return {
            bytes: cachedBytes,
            downloadUrl: currentDownloadUrl,
            loading: false,
            error: null,
        };
    }

    return { bytes, downloadUrl, loading, error };
}

/**
 * Evict cache entries for a given document (e.g. after accept/reject
 * writes new bytes at the same storage path, or the user uploads a new
 * version). Pass a versionId to scope eviction; omit to clear every
 * cached version for that document.
 */
export function invalidateDocxBytes(
    documentId: string,
    versionId?: string | null,
): void {
    if (versionId !== undefined) {
        for (const key of Array.from(bytesCache.keys())) {
            if (key.startsWith(`${documentId}:${versionId ?? ""}:`)) {
                bytesCache.delete(key);
            }
        }
        return;
    }
    for (const key of Array.from(bytesCache.keys())) {
        if (key.startsWith(`${documentId}:`)) bytesCache.delete(key);
    }
}
