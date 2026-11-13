"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, FolderOpen, Loader2, Plus, Search } from "lucide-react";
import { CocoCommandBackdrop } from "@/app/components/shared/CocoCommandBackdrop";
import { CocoLegalIcon } from "@/components/chat/coco-legal-icon";
import { NewProjectModal } from "@/app/components/projects/NewProjectModal";
import { listProjects } from "@/app/lib/cocoLegalApi";
import { matterDocReviewHref } from "@/app/lib/matterRoutes";
import type { CocoLegalProject } from "@/app/components/shared/types";
import { AppBackButton } from "@/app/components/shared/AppBackButton";

function formatRecentMatterDate(project: CocoLegalProject) {
    const raw = project.updated_at || project.created_at;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return "No activity";
    return date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
    });
}

export default function DocReviewLauncherPage() {
    const router = useRouter();
    const [projects, setProjects] = useState<CocoLegalProject[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [newMatterOpen, setNewMatterOpen] = useState(false);

    useEffect(() => {
        let cancelled = false;
        listProjects()
            .then((loaded) => {
                if (!cancelled) setProjects(loaded);
            })
            .catch(() => {
                if (!cancelled) setProjects([]);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const filteredProjects = useMemo(() => {
        const q = search.trim().toLowerCase();
        const ordered = [...projects].sort(
            (a, b) =>
                Date.parse(b.updated_at || b.created_at) -
                Date.parse(a.updated_at || a.created_at),
        );
        if (!q) return ordered;
        return ordered.filter(
            (project) =>
                project.name.toLowerCase().includes(q) ||
                (project.cm_number ?? "").toLowerCase().includes(q),
        );
    }, [projects, search]);

    return (
        <div className="relative flex h-full w-full overflow-hidden bg-[var(--app-shell)] px-5 py-6 text-[var(--app-text)] md:px-8">
            <CocoCommandBackdrop variant="hero" />

            <main className="relative z-10 mx-auto flex w-full max-w-6xl flex-col">
                <header className="flex flex-wrap items-center justify-between gap-4">
                    <div className="flex min-w-0 items-start gap-3">
                        <AppBackButton variant="dark" className="mt-1" />
                        <div className="min-w-0">
                            <div className="flex items-center gap-3">
                                <CocoLegalIcon
                                    size={28}
                                    style={{
                                        filter:
                                            "drop-shadow(0 0 18px rgba(251, 191, 36, 0.22)) brightness(1.65)",
                                    }}
                                />
                                <h1 className="font-serif text-4xl font-light tracking-normal text-[var(--app-text-strong)] md:text-5xl">
                                    Doc Review
                                </h1>
                            </div>
                            <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--app-text-muted)] md:text-base">
                                Open a matter review workspace with documents,
                                citations, redlines, and matter-aware assistant
                                context.
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={() => setNewMatterOpen(true)}
                        className="flex h-10 items-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-command-muted)] px-4 text-sm font-medium text-[var(--app-text-strong)] shadow-[var(--app-elevated-shadow)] transition hover:border-[var(--app-border-strong)] hover:bg-[var(--app-hover)]"
                    >
                        <Plus className="h-4 w-4" />
                        New Matter
                    </button>
                </header>

                <section className="mt-10 overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-command)] shadow-[var(--app-command-shadow)] backdrop-blur-md">
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--app-border)] px-4 py-3 md:px-5">
                        <div className="flex items-center gap-2 text-sm font-medium text-[var(--app-text-strong)]">
                            <FolderOpen className="h-4 w-4 text-[var(--app-warm)]" />
                            Matters ready for review
                        </div>
                        <label className="flex h-9 min-w-0 items-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-command-input)] px-3 text-sm text-[var(--app-text-muted)] focus-within:border-[var(--app-border-strong)] md:min-w-[280px]">
                            <Search className="h-4 w-4 shrink-0 text-[var(--app-text-subtle)]" />
                            <input
                                value={search}
                                onChange={(event) =>
                                    setSearch(event.target.value)
                                }
                                placeholder="Search matters..."
                                className="min-w-0 flex-1 bg-transparent text-sm text-[var(--app-text-strong)] outline-none placeholder:text-[var(--app-text-subtle)]"
                            />
                        </label>
                    </div>

                    <div className="max-h-[calc(100dvh-260px)] min-h-[280px] overflow-y-auto">
                        {loading ? (
                            <div className="flex h-64 items-center justify-center text-[var(--app-text-subtle)]">
                                <Loader2 className="h-5 w-5 animate-spin" />
                            </div>
                        ) : filteredProjects.length === 0 ? (
                            <div className="flex h-64 flex-col items-center justify-center gap-3 px-6 text-center">
                                <FileText className="h-8 w-8 text-[var(--app-text-subtle)]" />
                                <div>
                                    <p className="text-sm font-medium text-[var(--app-text-strong)]">
                                        No matters found
                                    </p>
                                    <p className="mt-1 text-xs text-[var(--app-text-subtle)]">
                                        Create a matter and attach documents to
                                        start review.
                                    </p>
                                </div>
                            </div>
                        ) : (
                            <div className="divide-y divide-[var(--app-border)]">
                                {filteredProjects.map((project) => (
                                    <button
                                        key={project.id}
                                        onClick={() =>
                                            router.push(
                                                matterDocReviewHref(project.id),
                                            )
                                        }
                                        className="grid w-full grid-cols-1 gap-3 px-4 py-4 text-left transition hover:bg-[var(--app-hover)] md:grid-cols-[minmax(0,1fr)_120px_120px_150px] md:items-center md:px-5"
                                    >
                                        <div className="min-w-0">
                                            <p className="truncate text-sm font-medium text-[var(--app-text-strong)]">
                                                {project.name}
                                            </p>
                                            <p className="mt-1 truncate text-xs text-[var(--app-text-subtle)]">
                                                {project.cm_number
                                                    ? `Matter # ${project.cm_number}`
                                                    : "No matter number"}
                                            </p>
                                        </div>
                                        <div className="text-xs text-[var(--app-text-muted)]">
                                            <span className="text-[var(--app-text-strong)]">
                                                {project.document_count ?? 0}
                                            </span>{" "}
                                            docs
                                        </div>
                                        <div className="text-xs text-[var(--app-text-muted)]">
                                            <span className="text-[var(--app-text-strong)]">
                                                {project.review_count ?? 0}
                                            </span>{" "}
                                            tables
                                        </div>
                                        <div className="text-xs text-[var(--app-text-subtle)]">
                                            {formatRecentMatterDate(project)}
                                        </div>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </section>
            </main>

            <NewProjectModal
                open={newMatterOpen}
                onClose={() => setNewMatterOpen(false)}
                onCreated={(project) => {
                    setProjects((prev) => [project, ...prev]);
                    router.push(matterDocReviewHref(project.id));
                }}
            />
        </div>
    );
}
