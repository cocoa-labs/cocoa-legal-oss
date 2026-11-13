"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Plus, Library, FileText, Check, ChevronDown } from "lucide-react";
import { HeaderSearchBtn } from "../shared/HeaderSearchBtn";
import { listTemplates, deleteTemplate } from "@/app/lib/cocoLegalApi";
import type { DocTemplate } from "../shared/types";
import { DOC_TYPE_LABELS } from "./builtinTemplates";
import { TemplateDetailModal } from "./TemplateDetailModal";
import { NewTemplateModal } from "./NewTemplateModal";
import { NewDraftModal } from "./NewDraftModal";
import {
    OpenDraftInMatterModal,
    type OpenDraftDoc,
} from "../assistant/OpenDraftInMatterModal";
import { ToolbarTabs } from "../shared/ToolbarTabs";
import { RowActions } from "../shared/RowActions";
import { CocoLegalIcon } from "@/components/chat/coco-legal-icon";
import { AppBackButton } from "../shared/AppBackButton";

type Tab = "all" | "builtin" | "firm" | "hidden";

const NAME_COL_W = "w-[300px] shrink-0";

// Templates have no backend hidden-list (unlike workflows, which use
// /workflows/hidden). The shared Coco Legal-default rows (`source_kind:
// "coco_seed"`) can't be deleted, so "hiding" one is a per-browser
// preference persisted in localStorage — the template-management analogue of
// WorkflowList's hide mechanism, just client-side because no server endpoint
// exists. Firm-owned rows are deleted (archived) via the API instead.
const HIDDEN_TEMPLATES_KEY = "coco-legal:hidden-templates";

function readHiddenTemplateIds(): string[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = window.localStorage.getItem(HIDDEN_TEMPLATES_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed)
            ? parsed.filter((x): x is string => typeof x === "string")
            : [];
    } catch {
        return [];
    }
}

function writeHiddenTemplateIds(ids: string[]) {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(HIDDEN_TEMPLATES_KEY, JSON.stringify(ids));
    } catch {
        // Best-effort: a write failure (quota / disabled storage) just means
        // the hide doesn't persist across reloads; the in-memory state still
        // reflects it for this session.
    }
}

// Tiny external store over the localStorage hidden-list, consumed via
// useSyncExternalStore. The server snapshot is the empty list, matching what
// the server actually rendered; React swaps in the real client snapshot right
// after hydration — the same "[] first paint, then the persisted ids" the old
// setState-on-mount effect produced, without a hydration mismatch.
const NO_HIDDEN_IDS: string[] = [];
// Snapshot cache: useSyncExternalStore requires getSnapshot to return the
// SAME reference until the store changes, so parse localStorage once and
// invalidate only on our own writes.
let hiddenIdsSnapshot: string[] | null = null;
const hiddenIdsListeners = new Set<() => void>();

function getHiddenIdsSnapshot(): string[] {
    if (hiddenIdsSnapshot === null) hiddenIdsSnapshot = readHiddenTemplateIds();
    return hiddenIdsSnapshot;
}

function getHiddenIdsServerSnapshot(): string[] {
    return NO_HIDDEN_IDS;
}

function subscribeHiddenIds(onChange: () => void): () => void {
    hiddenIdsListeners.add(onChange);
    return () => {
        hiddenIdsListeners.delete(onChange);
    };
}

function setHiddenTemplateIds(next: string[]) {
    hiddenIdsSnapshot = next;
    writeHiddenTemplateIds(next);
    hiddenIdsListeners.forEach((listener) => listener());
}

/** A coco_seed template is a shared default — hide, don't delete. */
function isCocoSeed(t: DocTemplate): boolean {
    return t.source_kind === "coco_seed";
}

/** Firm-owned (parameterized or AI-generated) → deletable (archive). */
function isFirmOwned(t: DocTemplate): boolean {
    return (
        t.source_kind === "firm_parameterized" ||
        t.source_kind === "ai_generated"
    );
}

function sourceMeta(t: DocTemplate): { label: string; firm: boolean } {
    if (isCocoSeed(t)) return { label: "Coco Legal", firm: false };
    if (t.source_kind === "ai_generated") return { label: "AI", firm: true };
    return { label: "Firm", firm: true };
}

const TABS: { id: Tab; label: string }[] = [
    { id: "all", label: "All" },
    { id: "builtin", label: "Built-in defaults" },
    { id: "firm", label: "Firm" },
    { id: "hidden", label: "Hidden" },
];

export function TemplateList() {
    const [templates, setTemplates] = useState<DocTemplate[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    // Hidden-template ids come straight from the localStorage-backed store —
    // no mount effect copying them into state (that synchronous setState was
    // a cascading-render lint error under the React Compiler).
    const hiddenIds = useSyncExternalStore(
        subscribeHiddenIds,
        getHiddenIdsSnapshot,
        getHiddenIdsServerSnapshot,
    );
    const [activeTab, setActiveTab] = useState<Tab>("all");
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [newModalOpen, setNewModalOpen] = useState(false);
    const [draftTemplateId, setDraftTemplateId] = useState<string | null>(null);
    const [pendingOpen, setPendingOpen] = useState<OpenDraftDoc | null>(null);
    const [practiceFilter, setPracticeFilter] = useState<string | null>(null);
    const [practiceFilterOpen, setPracticeFilterOpen] = useState(false);
    const [search, setSearch] = useState("");
    const practiceFilterRef = useRef<HTMLDivElement>(null);

    // The bare fetch — every setState here runs when the promise settles, so
    // the mount effect can call it without a synchronous setState. The mount
    // path's spinner comes from the INITIAL loading=true / error=null state.
    function fetchTemplates() {
        // listTemplates() already excludes archived rows server-side, so the
        // optimistic removal after a delete and this refetch stay consistent.
        listTemplates()
            .then((rows) => setTemplates(rows))
            .catch((err) =>
                setError(
                    err instanceof Error
                        ? err.message
                        : "Could not load templates.",
                ),
            )
            .finally(() => setLoading(false));
    }

    /** Event-handler refresh: re-show the spinner, clear the error, refetch. */
    function loadTemplates() {
        setLoading(true);
        setError(null);
        fetchTemplates();
    }

    useEffect(() => {
        // Initial load only; refreshes go through loadTemplates() from event
        // handlers (retry button, template-created callback).
        fetchTemplates();
    }, []);

    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (
                practiceFilterRef.current &&
                !practiceFilterRef.current.contains(e.target as Node)
            ) {
                setPracticeFilterOpen(false);
            }
        }
        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, []);

    function handleHideTemplate(id: string) {
        const prev = getHiddenIdsSnapshot();
        if (prev.includes(id)) return;
        setHiddenTemplateIds([...prev, id]);
    }

    function handleUnhideTemplate(id: string) {
        setHiddenTemplateIds(
            getHiddenIdsSnapshot().filter((x) => x !== id),
        );
    }

    /** Drop a row from local state only — no network call. */
    function removeTemplateLocally(id: string) {
        setTemplates((prev) => prev.filter((t) => t.id !== id));
    }

    async function handleDeleteTemplate(id: string) {
        // Optimistically drop the row; restore it if the archive call fails.
        const previous = templates;
        removeTemplateLocally(id);
        try {
            await deleteTemplate(id);
        } catch {
            setTemplates(previous);
        }
    }

    const hidden = templates.filter((t) => hiddenIds.includes(t.id));
    const cocoDefaults = templates.filter(
        (t) => isCocoSeed(t) && !hiddenIds.includes(t.id),
    );
    const firmTemplates = templates.filter(
        (t) => isFirmOwned(t) && !hiddenIds.includes(t.id),
    );
    const visible = templates.filter((t) => !hiddenIds.includes(t.id));

    const byTab =
        activeTab === "builtin"
            ? cocoDefaults
            : activeTab === "firm"
              ? firmTemplates
              : activeTab === "hidden"
                ? hidden
                : visible;

    const practices = Array.from(
        new Set(byTab.map((t) => t.practice).filter((p): p is string => !!p)),
    ).sort();

    const q = search.toLowerCase();
    const filtered = byTab
        .filter((t) => !practiceFilter || t.practice === practiceFilter)
        .filter(
            (t) =>
                !q ||
                t.title.toLowerCase().includes(q) ||
                (DOC_TYPE_LABELS[t.doc_type] ?? t.doc_type)
                    .toLowerCase()
                    .includes(q),
        );

    const practiceFilterButton = (
        <div className="relative" ref={practiceFilterRef}>
            <button
                onClick={() => setPracticeFilterOpen((o) => !o)}
                className={`flex items-center gap-1 text-xs font-medium transition-colors ${
                    practiceFilter
                        ? "text-[var(--app-text)] hover:text-[var(--app-text-strong)]"
                        : "text-[var(--app-text-subtle)] hover:text-[var(--app-text)]"
                }`}
            >
                {practiceFilter ?? "Filter by practice"}
                <ChevronDown className="h-3 w-3" />
            </button>
            {practiceFilterOpen && (
                <div className="absolute right-0 top-full z-20 mt-1.5 w-52 overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] shadow-lg">
                    <button
                        onClick={() => {
                            setPracticeFilter(null);
                            setPracticeFilterOpen(false);
                        }}
                        className="flex w-full items-center justify-between px-3 py-2 text-xs text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-hover)]"
                    >
                        All Practices
                        {!practiceFilter && (
                            <Check className="h-3.5 w-3.5 text-[var(--app-text-muted)]" />
                        )}
                    </button>
                    {practices.length > 0 && (
                        <div className="border-t border-[var(--app-border)]" />
                    )}
                    {practices.map((p) => (
                        <button
                            key={p}
                            onClick={() => {
                                setPracticeFilter(p);
                                setPracticeFilterOpen(false);
                            }}
                            className="flex w-full items-center justify-between px-3 py-2 text-xs text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-hover)]"
                        >
                            <span className="truncate pr-2">{p}</span>
                            {practiceFilter === p && (
                                <Check className="h-3.5 w-3.5 shrink-0 text-[var(--app-text-muted)]" />
                            )}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );

    const toolbarActions = (
        <div className="flex items-center gap-5">{practiceFilterButton}</div>
    );

    const renderTemplateRow = (t: DocTemplate) => {
        const { label: sourceLabel, firm } = sourceMeta(t);
        const docTypeLabel = DOC_TYPE_LABELS[t.doc_type] ?? t.doc_type;
        return (
            <div
                key={t.id}
                onClick={() => setSelectedId(t.id)}
                className="group flex h-10 cursor-pointer items-center border-b border-[var(--app-border)] pr-3 transition-colors hover:bg-[var(--app-hover)] md:pr-10"
            >
                <div
                    className={`sticky left-0 z-[60] ${NAME_COL_W} self-stretch flex flex-col justify-center py-2 pr-2 pl-4 md:pl-10 bg-[var(--app-shell)] group-hover:bg-[var(--app-panel-strong)]`}
                >
                    <span className="block truncate text-sm text-[var(--app-text)]">
                        {t.title}
                    </span>
                </div>
                <div className="ml-auto w-44 shrink-0">
                    <span className="text-xs font-medium text-[var(--app-text-muted)]">
                        {docTypeLabel}
                    </span>
                </div>
                <div className="w-40 shrink-0">
                    {t.practice ? (
                        <span className="text-xs font-medium text-[var(--app-text-muted)]">
                            {t.practice}
                        </span>
                    ) : (
                        <span className="text-xs text-[var(--app-text-subtle)]">
                            —
                        </span>
                    )}
                </div>
                <div className="w-28 shrink-0">
                    {firm ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--app-active)] px-2 py-0.5 text-xs font-medium text-[var(--app-text-muted)]">
                            {sourceLabel}
                        </span>
                    ) : (
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--app-text-muted)]">
                            <CocoLegalIcon size={14} />
                            {sourceLabel}
                        </span>
                    )}
                </div>
                <div
                    className="w-8 shrink-0 flex justify-end"
                    onClick={(e) => e.stopPropagation()}
                >
                    {isCocoSeed(t) ? (
                        hiddenIds.includes(t.id) ? (
                            <RowActions
                                onUnhide={() => handleUnhideTemplate(t.id)}
                            />
                        ) : (
                            <RowActions onHide={() => handleHideTemplate(t.id)} />
                        )
                    ) : (
                        <RowActions
                            onDelete={() => handleDeleteTemplate(t.id)}
                        />
                    )}
                </div>
            </div>
        );
    };

    return (
        <div className="flex flex-1 flex-col overflow-hidden bg-[var(--app-shell)] text-[var(--app-text)]">
            {/* Page header */}
            <div className="mb-1 flex items-center justify-between px-4 py-3 md:px-10 shrink-0">
                <div className="flex min-w-0 items-center gap-2">
                    <AppBackButton variant="dark" />
                    <h1 className="truncate text-2xl font-medium font-serif text-[var(--app-text-strong)]">
                        Templates
                    </h1>
                </div>
                <div className="flex items-center gap-2">
                    <HeaderSearchBtn
                        value={search}
                        onChange={setSearch}
                        placeholder="Search templates…"
                        variant="dark"
                    />
                    <button
                        onClick={() => setNewModalOpen(true)}
                        className="flex items-center justify-center rounded-lg p-1.5 text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                    >
                        <Plus className="h-4 w-4" />
                    </button>
                </div>
            </div>

            <ToolbarTabs
                tabs={TABS}
                active={activeTab}
                onChange={(tab) => setActiveTab(tab)}
                variant="dark"
                actions={toolbarActions}
            />

            {/* Table */}
            <div className="flex-1 overflow-auto">
                <div className="min-w-max">
                    {/* Column headers */}
                    <div className="flex h-8 items-center border-b border-[var(--app-border)] pr-3 text-xs font-medium text-[var(--app-text-subtle)] select-none md:pr-10">
                        <div
                            className={`sticky left-0 z-[60] ${NAME_COL_W} bg-[var(--app-shell)] pl-4 md:pl-10 text-left`}
                        >
                            Name
                        </div>
                        <div className="ml-auto w-44 shrink-0">Doc type</div>
                        <div className="w-40 shrink-0">Practice</div>
                        <div className="w-28 shrink-0">Source</div>
                        <div className="w-8 shrink-0" />
                    </div>

                    {loading ? (
                        <div>
                            {[1, 2, 3].map((i) => (
                                <div
                                    key={i}
                                    className="flex h-10 items-center border-b border-[var(--app-border)] pr-3 md:pr-10"
                                >
                                    <div className="flex-1 min-w-0 pl-4 pr-4 md:pl-10">
                                        <div className="h-3.5 w-48 animate-pulse rounded bg-[var(--app-active)]" />
                                    </div>
                                    <div className="w-44 shrink-0">
                                        <div className="h-3 w-24 animate-pulse rounded bg-[var(--app-active)]" />
                                    </div>
                                    <div className="w-40 shrink-0">
                                        <div className="h-3 w-20 animate-pulse rounded bg-[var(--app-active)]" />
                                    </div>
                                    <div className="w-28 shrink-0">
                                        <div className="h-3 w-14 animate-pulse rounded bg-[var(--app-active)]" />
                                    </div>
                                    <div className="w-8 shrink-0" />
                                </div>
                            ))}
                        </div>
                    ) : error ? (
                        <div className="flex flex-col items-start py-24 w-full max-w-xs mx-auto">
                            <Library className="mb-4 h-8 w-8 text-[var(--app-text-subtle)]" />
                            <p className="font-serif text-2xl font-medium text-[var(--app-text-strong)]">
                                Couldn&apos;t load templates
                            </p>
                            <p className="mt-1 text-left text-xs text-[var(--app-text-subtle)]">
                                {error}
                            </p>
                            <button
                                onClick={loadTemplates}
                                className="mt-4 inline-flex items-center gap-1 rounded-full bg-[var(--app-active-strong)] px-3 py-1 text-xs font-medium text-[var(--app-active-foreground)] shadow-md transition-colors hover:opacity-90"
                            >
                                Try again
                            </button>
                        </div>
                    ) : filtered.length === 0 ? (
                        <div className="flex flex-col items-start py-24 w-full max-w-xs mx-auto">
                            {activeTab === "firm" ? (
                                <>
                                    <FileText className="mb-4 h-8 w-8 text-[var(--app-text-subtle)]" />
                                    <p className="font-serif text-2xl font-medium text-[var(--app-text-strong)]">
                                        Firm Templates
                                    </p>
                                    <p className="mt-1 text-left text-xs text-[var(--app-text-subtle)]">
                                        Parameterize a sample document or generate
                                        a reusable template tailored to your
                                        firm&apos;s house style.
                                    </p>
                                    <button
                                        onClick={() => setNewModalOpen(true)}
                                        className="mt-4 inline-flex items-center gap-1 rounded-full bg-[var(--app-active-strong)] px-3 py-1 text-xs font-medium text-[var(--app-active-foreground)] shadow-md transition-colors hover:opacity-90"
                                    >
                                        + New template
                                    </button>
                                </>
                            ) : activeTab === "hidden" ? (
                                <>
                                    <Library className="mb-4 h-8 w-8 text-[var(--app-text-subtle)]" />
                                    <p className="font-serif text-2xl font-medium text-[var(--app-text-strong)]">
                                        Hidden Templates
                                    </p>
                                    <p className="mt-1 text-left text-xs text-[var(--app-text-subtle)]">
                                        Coco Legal default templates you&apos;ve hidden
                                        will appear here. You can unhide them at
                                        any time.
                                    </p>
                                </>
                            ) : (
                                <>
                                    <Library className="mb-4 h-8 w-8 text-[var(--app-text-subtle)]" />
                                    <p className="font-serif text-2xl font-medium text-[var(--app-text-strong)]">
                                        Templates
                                    </p>
                                    <p className="mt-1 text-left text-xs text-[var(--app-text-subtle)]">
                                        Draft documents from reusable, firm-tuned
                                        templates with a dynamic intake form.
                                    </p>
                                    <button
                                        onClick={() => setNewModalOpen(true)}
                                        className="mt-4 inline-flex items-center gap-1 rounded-full bg-[var(--app-active-strong)] px-3 py-1 text-xs font-medium text-[var(--app-active-foreground)] shadow-md transition-colors hover:opacity-90"
                                    >
                                        + New template
                                    </button>
                                </>
                            )}
                        </div>
                    ) : (
                        filtered.map(renderTemplateRow)
                    )}
                </div>
            </div>

            <TemplateDetailModal
                open={selectedId !== null}
                templateId={selectedId}
                onClose={() => setSelectedId(null)}
                onUseTemplate={(id) => {
                    setSelectedId(null);
                    setDraftTemplateId(id);
                }}
                onDeleted={() => {
                    // The modal already performed the server-side DELETE (and
                    // owns its error handling). Only sync local state here —
                    // calling deleteTemplate again would fire a second request.
                    const id = selectedId;
                    setSelectedId(null);
                    if (id) removeTemplateLocally(id);
                }}
            />

            <NewTemplateModal
                open={newModalOpen}
                onClose={() => setNewModalOpen(false)}
                onCreated={(id) => {
                    setNewModalOpen(false);
                    loadTemplates();
                    setSelectedId(id);
                }}
            />

            {/* Standalone "Use template" draft flow. The draft has no matter
                yet and Doc Review is matter-scoped, so "Open document" files it
                into a matter (picked/created below) and opens it there. */}
            <NewDraftModal
                open={draftTemplateId !== null}
                onClose={() => setDraftTemplateId(null)}
                initialTemplateId={draftTemplateId ?? undefined}
                onOpenDocument={(d) =>
                    setPendingOpen({
                        documentId: d.documentId,
                        versionId: d.versionId,
                        filename: d.filename,
                    })
                }
            />

            <OpenDraftInMatterModal
                open={!!pendingOpen}
                doc={pendingOpen}
                onClose={() => setPendingOpen(null)}
            />
        </div>
    );
}
