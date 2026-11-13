"use client";

import { useEffect, useState } from "react";
import { getProject, listProjects, listStandaloneDocuments } from "@/app/lib/cocoLegalApi";
import type { CocoLegalDocument, CocoLegalProject } from "./types";

const CACHE_TTL_MS = 30_000;

interface DirectoryCache {
    standaloneDocuments: CocoLegalDocument[];
    projects: CocoLegalProject[];
    fetchedAt: number;
}

let cache: DirectoryCache | null = null;

export function invalidateDirectoryCache() {
    cache = null;
}

export function useDirectoryData(enabled: boolean) {
    const [loading, setLoading] = useState(true);
    const [standaloneDocuments, setStandaloneDocuments] = useState<CocoLegalDocument[]>([]);
    const [projects, setProjects] = useState<CocoLegalProject[]>([]);

    useEffect(() => {
        if (!enabled) return;

        let cancelled = false;
        const now = Date.now();
        if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
            queueMicrotask(() => {
                if (cancelled || !cache) return;
                setStandaloneDocuments(cache.standaloneDocuments);
                setProjects(cache.projects);
                setLoading(false);
            });
            return () => {
                cancelled = true;
            };
        }

        queueMicrotask(() => {
            if (!cancelled) setLoading(true);
        });
        Promise.all([listProjects(), listStandaloneDocuments()])
            .then(([ps, ds]) => {
                const sorted = [...ds].sort((a, b) =>
                    (b.created_at ?? "").localeCompare(a.created_at ?? ""),
                );
                return Promise.all(ps.map((p) => getProject(p.id))).then(
                    (fullProjects) => {
                        cache = {
                            standaloneDocuments: sorted,
                            projects: fullProjects,
                            fetchedAt: Date.now(),
                        };
                        if (cancelled) return;
                        setStandaloneDocuments(sorted);
                        setProjects(fullProjects);
                    },
                );
            })
            .catch(() => {
                if (cancelled) return;
                setStandaloneDocuments([]);
                setProjects([]);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [enabled]);

    return { loading, standaloneDocuments, projects };
}
