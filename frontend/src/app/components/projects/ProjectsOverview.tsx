"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, FolderOpen, ChevronDown, FileSignature, ChevronRight } from "lucide-react";
import { HeaderSearchBtn } from "@/app/components/shared/HeaderSearchBtn";
import { listProjects, updateProject, deleteProject } from "@/app/lib/cocoLegalApi";
import { useSignatureSummary } from "@/app/components/legal/SignatureSummaryContext";
import { OwnerOnlyModal } from "@/app/components/shared/OwnerOnlyModal";
import { useAuth } from "@/contexts/AuthContext";
import type { CocoLegalProject } from "@/app/components/shared/types";
import { NewProjectModal } from "./NewProjectModal";
import { ToolbarTabs } from "@/app/components/shared/ToolbarTabs";
import { RowActions } from "@/app/components/shared/RowActions";
import { matterDefaultHref } from "@/app/lib/matterRoutes";
import { AppBackButton } from "@/app/components/shared/AppBackButton";

function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
    });
}

type Tab = "all" | "mine" | "shared-with-me";

const CHECK_W = "w-8 shrink-0";
const NAME_COL_W = "w-[300px] shrink-0";

export function ProjectsOverview() {
    const [projects, setProjects] = useState<CocoLegalProject[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [modalOpen, setModalOpen] = useState(false);
    const [activeTab, setActiveTab] = useState<Tab>("all");
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const [cmEditingId, setCmEditingId] = useState<string | null>(null);
    const [cmValue, setCmValue] = useState("");
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [actionsOpen, setActionsOpen] = useState(false);
    const [search, setSearch] = useState("");
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
    const actionsRef = useRef<HTMLDivElement>(null);
    const router = useRouter();
    const { user, isAuthenticated, authLoading } = useAuth();

    useEffect(() => {
        let cancelled = false;
        if (authLoading) {
            queueMicrotask(() => {
                if (!cancelled) setLoading(true);
            });
            return () => {
                cancelled = true;
            };
        }
        if (!isAuthenticated) {
            queueMicrotask(() => {
                if (cancelled) return;
                setProjects([]);
                setLoadError(null);
                setLoading(false);
            });
            return () => {
                cancelled = true;
            };
        }

        queueMicrotask(() => {
            if (cancelled) return;
            setLoading(true);
            setLoadError(null);
        });
        listProjects()
            .then((loaded) => {
                if (!cancelled) setProjects(loaded);
            })
            .catch(() => {
                if (!cancelled) {
                    setProjects([]);
                    setLoadError("Could not load matters.");
                }
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [authLoading, isAuthenticated, user?.id]);

    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (
                actionsRef.current &&
                !actionsRef.current.contains(e.target as Node)
            )
                setActionsOpen(false);
        }
        if (actionsOpen) document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [actionsOpen]);

    const q = search.toLowerCase();
    const filtered = (
        activeTab === "all"
            ? projects
            : activeTab === "mine"
              ? projects.filter((p) => p.is_owner ?? p.user_id === user?.id)
              : projects.filter((p) => !(p.is_owner ?? p.user_id === user?.id))
    ).filter(
        (p) =>
            !q ||
            p.name.toLowerCase().includes(q) ||
            (p.cm_number ?? "").toLowerCase().includes(q),
    );

    const allSelected =
        filtered.length > 0 &&
        filtered.every((p) => selectedIds.includes(p.id));
    const someSelected =
        !allSelected && filtered.some((p) => selectedIds.includes(p.id));

    function toggleAll() {
        if (allSelected) {
            setSelectedIds([]);
        } else {
            setSelectedIds(filtered.map((p) => p.id));
        }
    }

    function toggleOne(id: string) {
        setSelectedIds((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
        );
    }

    const tabs: { id: Tab; label: string }[] = [
        { id: "all", label: "All" },
        { id: "mine", label: "Mine" },
        { id: "shared-with-me", label: "Shared with me" },
    ];

    async function handleRenameSubmit(projectId: string) {
        const trimmed = renameValue.trim();
        setRenamingId(null);
        if (!trimmed) return;
        setProjects((prev) =>
            prev.map((p) => (p.id === projectId ? { ...p, name: trimmed } : p)),
        );
        await updateProject(projectId, { name: trimmed });
    }

    async function handleCmSubmit(projectId: string) {
        const trimmed = cmValue.trim();
        setCmEditingId(null);
        setProjects((prev) =>
            prev.map((p) =>
                p.id === projectId ? { ...p, cm_number: trimmed || null } : p,
            ),
        );
        await updateProject(projectId, { cm_number: trimmed || undefined });
    }

    async function handleDeleteSelected() {
        const ids = [...selectedIds];
        setActionsOpen(false);
        // Only the matter owner can delete; the per-row delete is hidden
        // for shared matters but the bulk action can still pick them up
        // if a user toggled them across tabs. Filter and warn.
        const owned = ids.filter((id) => {
            const p = projects.find((pp) => pp.id === id);
            return !p || (p.is_owner ?? p.user_id === user?.id);
        });
        const blocked = ids.length - owned.length;
        setSelectedIds([]);
        await Promise.all(owned.map((id) => deleteProject(id).catch(() => {})));
        setProjects((prev) => prev.filter((p) => !owned.includes(p.id)));
        if (blocked > 0) {
            setOwnerOnlyAction(
                `delete ${blocked} of the selected matters — only the matter owner can delete a matter`,
            );
        }
    }

    const toolbarActions = (
        <>
            {selectedIds.length > 0 && (
                <div ref={actionsRef} className="relative">
                    <button
                        onClick={() => setActionsOpen((v) => !v)}
                        className="flex items-center gap-1 text-xs font-medium text-[var(--app-text-muted)] transition-colors hover:text-[var(--app-text-strong)]"
                    >
                        Actions
                        <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                    {actionsOpen && (
                        <div className="absolute right-0 top-full z-50 mt-1 w-36 overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] shadow-lg">
                            <button
                                onClick={handleDeleteSelected}
                                className="w-full px-3 py-1.5 text-left text-xs text-red-300 transition-colors hover:bg-red-500/10"
                            >
                                Delete
                            </button>
                        </div>
                    )}
                </div>
            )}
        </>
    );

    return (
        <div className="flex-1 overflow-y-auto bg-[var(--app-shell)] text-[var(--app-text)]">
            {/* Page header */}
            <div className="mb-1 flex items-center justify-between px-4 py-3 md:px-10">
                <div className="flex min-w-0 items-center gap-2">
                    <AppBackButton variant="dark" />
                    <h1 className="truncate text-2xl font-medium font-serif text-[var(--app-text-strong)]">
                        Matters
                    </h1>
                </div>
                <div className="flex items-center gap-2">
                    <HeaderSearchBtn
                        value={search}
                        onChange={setSearch}
                        placeholder="Search matters…"
                        variant="dark"
                    />
                    <button
                        onClick={() => setModalOpen(true)}
                        className="flex items-center justify-center rounded-lg p-1.5 text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                    >
                        <Plus className="h-4 w-4" />
                    </button>
                </div>
            </div>

            <div className="px-4 pb-3 md:px-10">
                <SignaturesSummaryCard />
            </div>

            <ToolbarTabs
                tabs={tabs}
                active={activeTab}
                onChange={(tab) => {
                    setActiveTab(tab);
                    setSelectedIds([]);
                }}
                variant="dark"
                actions={toolbarActions}
            />

            {/* Table */}
            <div className="w-full overflow-x-auto">
                <div className="min-w-max">
                {/* Column headers */}
                <div className="flex h-8 items-center border-b border-[var(--app-border)] pr-3 text-xs font-medium text-[var(--app-text-subtle)] select-none md:pr-10">
                    <div className={`sticky left-0 z-[60] ${CHECK_W} relative flex items-center justify-center self-stretch bg-[var(--app-shell)] before:absolute before:inset-x-0 before:bottom-0 before:h-px before:bg-[var(--app-shell)]`}>
                        {!loading && (
                            <input
                                type="checkbox"
                                checked={allSelected}
                                ref={(el) => {
                                    if (el) el.indeterminate = someSelected;
                                }}
                                onChange={toggleAll}
                                className="h-2.5 w-2.5 rounded border-gray-200 cursor-pointer accent-black"
                            />
                        )}
                    </div>
                    <div className={`sticky left-8 z-[60] ${NAME_COL_W} bg-[var(--app-shell)] pl-2 text-left`}>
                        Name
                    </div>
                    <div className="ml-auto w-32 shrink-0 text-left">Matter #</div>
                    <div className="w-24 shrink-0 text-left">Files</div>
                    <div className="w-24 shrink-0 text-left">Chats</div>
                    <div className="w-36 shrink-0 text-left">Reviews</div>
                    <div className="w-32 shrink-0 text-left">Created</div>
                    <div className="w-8 shrink-0" />
                </div>

                {loading ? (
                    <div>
                        {[1, 2, 3].map((i) => (
                            <div
                                key={i}
                                className="flex h-10 items-center border-b border-[var(--app-border)] pr-3 md:pr-10"
                            >
                                <div className="w-8 shrink-0" />
                                <div className="flex-1 min-w-0 pl-3 pr-4">
                                    <div className="h-3.5 w-48 animate-pulse rounded bg-[var(--app-active)]" />
                                </div>
                                <div className="w-32 shrink-0">
                                    <div className="h-3 w-20 animate-pulse rounded bg-[var(--app-active)]" />
                                </div>
                                <div className="w-24 shrink-0">
                                    <div className="h-3 w-8 animate-pulse rounded bg-[var(--app-active)]" />
                                </div>
                                <div className="w-24 shrink-0">
                                    <div className="h-3 w-8 animate-pulse rounded bg-[var(--app-active)]" />
                                </div>
                                <div className="w-36 shrink-0">
                                    <div className="h-3 w-8 animate-pulse rounded bg-[var(--app-active)]" />
                                </div>
                                <div className="w-32 shrink-0">
                                    <div className="h-3 w-20 animate-pulse rounded bg-[var(--app-active)]" />
                                </div>
                                <div className="w-8 shrink-0" />
                            </div>
                        ))}
                    </div>
                ) : loadError ? (
                    <div className="flex flex-col items-start py-24 w-full max-w-xs mx-auto">
                        <FolderOpen className="mb-4 h-8 w-8 text-[var(--app-text-subtle)]" />
                        <p className="font-serif text-2xl font-medium text-[var(--app-text-strong)]">
                            Matters
                        </p>
                        <p className="mt-1 text-xs text-red-500 max-w-xs">
                            {loadError}
                        </p>
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="flex flex-col items-start py-24 w-full max-w-xs mx-auto">
                        {activeTab === "all" || activeTab === "mine" ? (
                            <>
                                <FolderOpen className="mb-4 h-8 w-8 text-[var(--app-text-subtle)]" />
                                <p className="font-serif text-2xl font-medium text-[var(--app-text-strong)]">
                                    Matters
                                </p>
                                <p className="mt-1 max-w-xs text-xs text-[var(--app-text-subtle)]">
                                    Open a document review workspace with
                                    matter-aware chat, citations, extraction
                                    tables, and chain-of-custody activity.
                                </p>
                                <button
                                    onClick={() => setModalOpen(true)}
                                    className="mt-4 inline-flex items-center gap-1 rounded-full bg-[var(--app-active-strong)] px-3 py-1 text-xs font-medium text-[var(--app-active-foreground)] shadow-md transition-colors hover:opacity-90"
                                >
                                    + Create New
                                </button>
                            </>
                        ) : (
                            <p className="text-sm text-[var(--app-text-subtle)]">
                                No {activeTab} matters
                            </p>
                        )}
                    </div>
                ) : (
                    <div>
                        {filtered.map((project) => {
                            const rowBg = selectedIds.includes(project.id)
                                ? "bg-[var(--app-active)]"
                                : "bg-[var(--app-shell)]";
                            return (
                            <div
                                key={project.id}
                                onClick={() => {
                                    if (renamingId === project.id) return;
                                    router.push(matterDefaultHref(project.id));
                                }}
                                className="group flex h-10 cursor-pointer items-center border-b border-[var(--app-border)] pr-3 transition-colors hover:bg-[var(--app-hover)] md:pr-10"
                            >
                                <div
                                    className={`sticky left-0 z-[60] ${CHECK_W} flex items-center justify-center p-2 ${rowBg} group-hover:bg-[var(--app-panel-strong)]`}
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    <input
                                        type="checkbox"
                                        checked={selectedIds.includes(
                                            project.id,
                                        )}
                                        onChange={() => toggleOne(project.id)}
                                        className="h-2.5 w-2.5 rounded border-gray-200 cursor-pointer accent-black"
                                    />
                                </div>

                                {/* Matter Name */}
                                <div className={`sticky left-8 z-[60] ${NAME_COL_W} ${rowBg} p-2 group-hover:bg-[var(--app-panel-strong)]`}>
                                    {renamingId === project.id ? (
                                        <input
                                            autoFocus
                                            value={renameValue}
                                            onChange={(e) =>
                                                setRenameValue(e.target.value)
                                            }
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter")
                                                    handleRenameSubmit(
                                                        project.id,
                                                    );
                                                if (e.key === "Escape")
                                                    setRenamingId(null);
                                            }}
                                            onBlur={() =>
                                                handleRenameSubmit(project.id)
                                            }
                                            onClick={(e) => e.stopPropagation()}
                                            className="w-full bg-transparent text-sm text-[var(--app-text-strong)] outline-none"
                                        />
                                    ) : (
                                        <span className="block truncate text-sm text-[var(--app-text)]">
                                            {project.name}
                                        </span>
                                    )}
                                </div>

                                <div
                                    className="ml-auto w-32 shrink-0 truncate text-sm text-[var(--app-text-subtle)]"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    {cmEditingId === project.id ? (
                                        <input
                                            autoFocus
                                            value={cmValue}
                                            onChange={(e) =>
                                                setCmValue(e.target.value)
                                            }
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter")
                                                    handleCmSubmit(project.id);
                                                if (e.key === "Escape")
                                                    setCmEditingId(null);
                                            }}
                                            onBlur={() =>
                                                handleCmSubmit(project.id)
                                            }
                                            placeholder="CM #"
                                            className="w-full bg-transparent text-sm text-[var(--app-text-strong)] outline-none"
                                        />
                                    ) : (
                                        (project.cm_number ?? (
                                            <span className="text-[var(--app-text-subtle)]">
                                                —
                                            </span>
                                        ))
                                    )}
                                </div>
                                <div className="w-24 shrink-0 truncate text-sm text-[var(--app-text-subtle)]">
                                    {project.document_count ?? 0}
                                </div>
                                <div className="w-24 shrink-0 truncate text-sm text-[var(--app-text-subtle)]">
                                    {project.chat_count ?? 0}
                                </div>
                                <div className="w-36 shrink-0 truncate text-sm text-[var(--app-text-subtle)]">
                                    {project.review_count ?? 0}
                                </div>
                                <div className="w-32 shrink-0 truncate text-sm text-[var(--app-text-subtle)]">
                                    {formatDate(project.created_at)}
                                </div>

                                <div
                                    className="w-8 shrink-0 flex justify-end"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    {(project.is_owner ??
                                        project.user_id === user?.id) && (
                                        <RowActions
                                            onRename={() => {
                                                setRenameValue(project.name);
                                                setRenamingId(project.id);
                                            }}
                                            onUpdateCmNumber={() => {
                                                setCmValue(
                                                    project.cm_number ?? "",
                                                );
                                                setCmEditingId(project.id);
                                            }}
                                            onDelete={async () => {
                                                await deleteProject(project.id);
                                                setProjects((prev) =>
                                                    prev.filter(
                                                        (p) =>
                                                            p.id !== project.id,
                                                    ),
                                                );
                                            }}
                                        />
                                    )}
                                </div>
                            </div>
                            );
                        })}
                    </div>
                )}
            </div>
            </div>

            <NewProjectModal
                open={modalOpen}
                onClose={() => setModalOpen(false)}
                onCreated={(p) => {
                    setProjects((prev) => [p, ...prev]);
                    router.push(matterDefaultHref(p.id));
                }}
            />

            <OwnerOnlyModal
                open={!!ownerOnlyAction}
                action={ownerOnlyAction ?? undefined}
                onClose={() => setOwnerOnlyAction(null)}
            />
        </div>
    );
}

const SIGNATURE_STATUS_LABELS: Record<string, string> = {
    sent: "Awaiting",
    partially_signed: "Partial",
    pending_approval: "Approval",
    completed: "Completed",
    declined: "Declined",
    cancelled: "Cancelled",
    expired: "Expired",
};

/**
 * Compact, link-through summary of the user's signature requests, shown on the
 * Matters overview. Reads the shared signature summary (one fetch app-wide) so
 * counts match the sidebar badge and the /signatures hub.
 */
function SignaturesSummaryCard() {
    const { pendingCount, completedCount, recent, loading } =
        useSignatureSummary();

    return (
        <Link
            href="/signatures"
            className="group flex flex-col gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-4 transition-colors hover:border-[var(--app-border-strong)] hover:bg-[var(--app-hover)] sm:flex-row sm:items-center"
        >
            <div className="flex min-w-0 flex-1 items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-purple-100 text-purple-800 ring-1 ring-purple-200">
                    <FileSignature className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                    <p className="text-sm font-semibold text-[var(--app-text-strong)]">
                        Signatures
                    </p>
                    <p className="text-xs text-[var(--app-text-subtle)]">
                        {loading
                            ? "Loading signature requests…"
                            : `${pendingCount} pending · ${completedCount} completed`}
                    </p>
                </div>
            </div>

            {recent.length > 0 && (
                <div className="hidden min-w-0 flex-1 flex-col gap-1 sm:flex">
                    {recent.slice(0, 3).map((item) => (
                        <div
                            key={item.envelope.id}
                            className="flex min-w-0 items-center gap-2 text-xs"
                        >
                            <span className="min-w-0 flex-1 truncate text-[var(--app-text-muted)]">
                                {item.envelope.subject ||
                                    item.envelope.document_name ||
                                    "Signature request"}
                            </span>
                            <span className="shrink-0 rounded-full bg-[var(--app-active)] px-2 py-0.5 text-[10px] font-medium text-[var(--app-text-muted)]">
                                {SIGNATURE_STATUS_LABELS[item.envelope.status] ??
                                    item.envelope.status}
                            </span>
                        </div>
                    ))}
                </div>
            )}

            <ChevronRight className="hidden h-4 w-4 shrink-0 text-[var(--app-text-subtle)] transition-colors group-hover:text-[var(--app-text-muted)] sm:block" />
        </Link>
    );
}
