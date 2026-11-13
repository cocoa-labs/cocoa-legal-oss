"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { API_BASE } from "@/app/lib/apiBase";

export interface DocumentVersionRow {
    id: string;
    version_number: number | null;
    source:
        | "upload"
        | "user_upload"
        | "assistant_edit"
        | "user_accept"
        | "user_reject"
        | "generated"
        | "clean_final";
    created_at: string;
    display_name?: string | null;
    created_by_user_id?: string | null;
    metadata?: Record<string, unknown>;
    layout_qa_status?: "source" | "unverified" | "passed" | "failed" | null;
    layout_qa_checked_at?: string | null;
    layout_qa_report?: Record<string, unknown> | null;
}

export interface DocumentVersionsResult {
    versions: DocumentVersionRow[];
    currentVersionId: string | null;
    loading: boolean;
    error: string | null;
    /** Refetch externally; used after accept/reject or new assistant edits. */
    refresh: () => void;
}

/**
 * Fetch the list of tracked versions for a document, with the numeric
 * version_number we use in UI labels ("V1", "V2", …).
 */
export function useDocumentVersions(
    documentId: string | null | undefined,
    refreshKey?: number,
    options?: { includeDecisions?: boolean },
): DocumentVersionsResult {
    const [versions, setVersions] = useState<DocumentVersionRow[]>([]);
    const [currentVersionId, setCurrentVersionId] = useState<string | null>(
        null,
    );
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [tick, setTick] = useState(0);

    useEffect(() => {
        if (!documentId) {
            setVersions([]);
            setCurrentVersionId(null);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError(null);

        (async () => {
            try {
                const {
                    data: { session },
                } = await supabase.auth.getSession();
                const token = session?.access_token;
                const qs = options?.includeDecisions
                    ? "?include_decisions=true"
                    : "";
                const resp = await fetch(
                    `${API_BASE}/single-documents/${documentId}/versions${qs}`,
                    {
                        headers: token
                            ? { Authorization: `Bearer ${token}` }
                            : {},
                    },
                );
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = (await resp.json()) as {
                    versions: DocumentVersionRow[];
                    current_version_id: string | null;
                };
                if (cancelled) return;
                setVersions(data.versions ?? []);
                setCurrentVersionId(data.current_version_id ?? null);
            } catch (e) {
                if (!cancelled)
                    setError(e instanceof Error ? e.message : String(e));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [documentId, refreshKey, tick, options?.includeDecisions]);

    return {
        versions,
        currentVersionId,
        loading,
        error,
        refresh: () => setTick((t) => t + 1),
    };
}
