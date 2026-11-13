"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
    Plus,
    Library,
    Table2,
    MessageSquare,
    User,
    ChevronDown,
    Check,
} from "lucide-react";
import { HeaderSearchBtn } from "../shared/HeaderSearchBtn";
import {
    listWorkflows,
    deleteWorkflow,
    listHiddenWorkflows,
    hideWorkflow,
    unhideWorkflow,
} from "@/app/lib/cocoLegalApi";
import type { CocoLegalWorkflow } from "../shared/types";
import { BUILT_IN_WORKFLOWS, BUILT_IN_IDS } from "./builtinWorkflows";
import { CRE_GALLERY_ID_SET, UK_COMMERCIAL_LEASE_ID } from "../legal/creShared";
import { DisplayWorkflowModal } from "./DisplayWorkflowModal";
import { NewWorkflowModal } from "./NewWorkflowModal";
import { ToolbarTabs } from "../shared/ToolbarTabs";
import { RowActions } from "../shared/RowActions";
import { CocoLegalIcon } from "@/components/chat/coco-legal-icon";
import { useAuth } from "@/contexts/AuthContext";
import { AppBackButton } from "../shared/AppBackButton";

type Tab = "all" | "builtin" | "custom" | "hidden";

const CHECK_W = "w-8 shrink-0";
const NAME_COL_W = "w-[300px] shrink-0";

// Ids grouped under the gallery's "Commercial Real Estate" section: the CRE
// suite (4 tabular packs + 4 assistant summaries) plus the UK commercial lease
// pack. Sourced from creShared so the gallery grouping and the CRE result-card
// gating stay in lockstep.
const LEGAL_OPERATIONS_IDS = CRE_GALLERY_ID_SET;

// The flagship CRE pack — the US lease abstraction, the suite's signature
// entry. Gets a small "Flagship" cue next to its name in the gallery.
const FLAGSHIP_WORKFLOW_ID = "builtin-us-commercial-lease";

// For the US demo, keep the UK commercial lease pack out of the displayed CRE
// section. The pack stays defined (still launchable elsewhere); it is simply
// not listed under "Commercial Real Estate" here.
const HIDDEN_FROM_CRE_SECTION: ReadonlySet<string> = new Set([
    UK_COMMERCIAL_LEASE_ID,
]);

// One-line, lawyerly descriptions for the built-in CRE workflows. Surfaced as
// a subtle secondary line under each CRE row's name (the CocoLegalWorkflow shape
// carries no description field, so the gallery supplies these for its own
// built-ins). Keyed by workflow id.
const CRE_WORKFLOW_DESCRIPTIONS: Record<string, string> = {
    "builtin-us-commercial-lease":
        "Abstract & risk-flag a US commercial lease against your firm's market positions.",
    "builtin-cre-estoppel":
        "Pull and flag the certified facts in a tenant estoppel certificate.",
    "builtin-cre-snda":
        "Abstract subordination, non-disturbance & attornment terms from an SNDA.",
    "builtin-cre-psa":
        "Abstract the key deal terms and contingencies of a purchase & sale agreement.",
    "builtin-cre-title-summary":
        "Summarize a title commitment — Schedule B exceptions, requirements & endorsements.",
    "builtin-cre-loi-summary":
        "Summarize an LOI and separate the binding terms from the non-binding deal points.",
    "builtin-cre-loan-summary":
        "Summarize a CRE loan — recourse carve-outs, reserves, prepayment & covenants.",
    "builtin-cre-ccr-summary":
        "Summarize CC&R / REA covenants that run with the land and bind the parcel.",
};

const TABS: { id: Tab; label: string }[] = [
    { id: "all", label: "All" },
    { id: "builtin", label: "Built-in" },
    { id: "custom", label: "Custom" },
    { id: "hidden", label: "Hidden" },
];

export function WorkflowList() {
    const router = useRouter();
    const { user } = useAuth();
    const [custom, setCustom] = useState<CocoLegalWorkflow[]>([]);
    const [loading, setLoading] = useState(true);
    const [selected, setSelected] = useState<CocoLegalWorkflow | null>(null);
    const [activeTab, setActiveTab] = useState<Tab>("all");
    const [newModalOpen, setNewModalOpen] = useState(false);
    const [hiddenBuiltinIds, setHiddenBuiltinIds] = useState<string[]>([]);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [actionsOpen, setActionsOpen] = useState(false);
    const [practiceFilter, setPracticeFilter] = useState<string | null>(null);
    const [practiceFilterOpen, setPracticeFilterOpen] = useState(false);
    const [typeFilter, setTypeFilter] = useState<CocoLegalWorkflow["type"] | null>(
        null,
    );
    const [typeFilterOpen, setTypeFilterOpen] = useState(false);
    const [search, setSearch] = useState("");
    const actionsRef = useRef<HTMLDivElement>(null);
    const practiceFilterRef = useRef<HTMLDivElement>(null);
    const typeFilterRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        Promise.all([
            listWorkflows("assistant"),
            listWorkflows("tabular"),
            listHiddenWorkflows(),
        ])
            .then(([assistant, tabular, hidden]) => {
                setCustom([...assistant, ...tabular]);
                setHiddenBuiltinIds(hidden);
            })
            .catch(() => setCustom([]))
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (
                actionsRef.current &&
                !actionsRef.current.contains(e.target as Node)
            ) {
                setActionsOpen(false);
            }
        }
        if (actionsOpen) document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [actionsOpen]);

    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (
                practiceFilterRef.current &&
                !practiceFilterRef.current.contains(e.target as Node)
            ) {
                setPracticeFilterOpen(false);
            }
            if (
                typeFilterRef.current &&
                !typeFilterRef.current.contains(e.target as Node)
            ) {
                setTypeFilterOpen(false);
            }
        }
        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, []);

    function resetSelection() {
        setSelectedIds([]);
        setActionsOpen(false);
    }

    const hiddenBuiltins = BUILT_IN_WORKFLOWS.filter((wf) =>
        hiddenBuiltinIds.includes(wf.id),
    );
    const visibleBuiltins = BUILT_IN_WORKFLOWS.filter(
        (wf) => !hiddenBuiltinIds.includes(wf.id),
    );
    const all = [...visibleBuiltins, ...custom];
    const byTab =
        activeTab === "builtin"
            ? visibleBuiltins
            : activeTab === "custom"
              ? custom
              : activeTab === "hidden"
                ? hiddenBuiltins
                : all;
    const practices = Array.from(
        new Set(byTab.map((wf) => wf.practice).filter((p): p is string => !!p)),
    ).sort();
    const q = search.toLowerCase();
    const filtered = byTab
        .filter((wf) => !practiceFilter || wf.practice === practiceFilter)
        .filter((wf) => !typeFilter || wf.type === typeFilter)
        .filter((wf) => !q || wf.title.toLowerCase().includes(q));

    const allSelected =
        filtered.length > 0 &&
        filtered.every((wf) => selectedIds.includes(wf.id));
    const someSelected =
        !allSelected && filtered.some((wf) => selectedIds.includes(wf.id));

    function toggleAll() {
        if (allSelected) setSelectedIds([]);
        else setSelectedIds(filtered.map((wf) => wf.id));
    }

    function toggleOne(id: string) {
        setSelectedIds((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
        );
    }

    async function handleHideWorkflow(id: string) {
        setHiddenBuiltinIds((prev) => [...prev, id]);
        await hideWorkflow(id).catch(() => {
            setHiddenBuiltinIds((prev) => prev.filter((x) => x !== id));
        });
    }

    async function handleUnhideWorkflow(id: string) {
        setHiddenBuiltinIds((prev) => prev.filter((x) => x !== id));
        await unhideWorkflow(id).catch(() => {
            setHiddenBuiltinIds((prev) => [...prev, id]);
        });
    }

    async function handleBulkRemove() {
        const ids = [...selectedIds];
        setActionsOpen(false);
        setSelectedIds([]);
        const builtinIds = ids.filter((id) => BUILT_IN_IDS.has(id));
        const customIds = ids.filter((id) => !BUILT_IN_IDS.has(id));
        if (builtinIds.length > 0) {
            setHiddenBuiltinIds((prev) => [
                ...prev,
                ...builtinIds.filter((id) => !prev.includes(id)),
            ]);
            await Promise.all(
                builtinIds.map((id) => hideWorkflow(id).catch(() => {})),
            );
        }
        if (customIds.length > 0) {
            await Promise.all(
                customIds.map((id) => deleteWorkflow(id).catch(() => {})),
            );
            setCustom((prev) => prev.filter((w) => !customIds.includes(w.id)));
        }
    }

    async function handleBulkUnhide() {
        const ids = [...selectedIds];
        setActionsOpen(false);
        setSelectedIds([]);
        setHiddenBuiltinIds((prev) => prev.filter((id) => !ids.includes(id)));
        await Promise.all(ids.map((id) => unhideWorkflow(id).catch(() => {})));
    }

    const getTypeMeta = (type: CocoLegalWorkflow["type"]) =>
        type === "tabular"
            ? { label: "Tabular", Icon: Table2, className: "text-violet-400" }
            : {
                  label: "Assistant",
                  Icon: MessageSquare,
                  className: "text-sky-400",
              };

    const typeFilterButton = (
        <div className="relative" ref={typeFilterRef}>
            <button
                onClick={() => setTypeFilterOpen((o) => !o)}
                className={`flex items-center gap-1 text-xs font-medium transition-colors ${
                    typeFilter
                        ? "text-[var(--app-text)] hover:text-[var(--app-text-strong)]"
                        : "text-[var(--app-text-subtle)] hover:text-[var(--app-text)]"
                }`}
            >
                {typeFilter
                    ? typeFilter === "tabular"
                        ? "Tabular"
                        : "Assistant"
                    : "Filter by type"}
                <ChevronDown className="h-3 w-3" />
            </button>
            {typeFilterOpen && (
                <div className="absolute right-0 top-full z-20 mt-1.5 w-40 overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] shadow-lg">
                    <button
                        onClick={() => {
                            setTypeFilter(null);
                            setTypeFilterOpen(false);
                            resetSelection();
                        }}
                        className="flex w-full items-center justify-between px-3 py-2 text-xs text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-hover)]"
                    >
                        All Types
                        {!typeFilter && (
                            <Check className="h-3.5 w-3.5 text-[var(--app-text-muted)]" />
                        )}
                    </button>
                    <div className="border-t border-[var(--app-border)]" />
                    {(["assistant", "tabular"] as const).map((t) => {
                        const { label, Icon, className } = getTypeMeta(t);
                        return (
                            <button
                                key={t}
                                onClick={() => {
                                    setTypeFilter(t);
                                    setTypeFilterOpen(false);
                                    resetSelection();
                                }}
                                className="flex w-full items-center justify-between px-3 py-2 text-xs transition-colors hover:bg-[var(--app-hover)]"
                            >
                                <span
                                    className={`inline-flex items-center gap-1.5 font-medium ${className}`}
                                >
                                    <Icon className="h-3.5 w-3.5" />
                                    {label}
                                </span>
                                {typeFilter === t && (
                                    <Check className="h-3.5 w-3.5 shrink-0 text-[var(--app-text-muted)]" />
                                )}
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
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
                            resetSelection();
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
                                resetSelection();
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
                            {activeTab === "hidden" ? (
                                <button
                                    onClick={handleBulkUnhide}
                                    className="w-full px-3 py-1.5 text-left text-xs text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-hover)]"
                                >
                                    Unhide
                                </button>
                            ) : (
                                <button
                                    onClick={handleBulkRemove}
                                    className="w-full px-3 py-1.5 text-left text-xs text-red-300 transition-colors hover:bg-red-500/10"
                                >
                                    Delete
                                </button>
                            )}
                        </div>
                    )}
                </div>
            )}
            <div className="flex items-center gap-5">
                {typeFilterButton}
                {practiceFilterButton}
            </div>
        </>
    );

    const renderWorkflowRow = (wf: CocoLegalWorkflow) => {
        const rowBg = selectedIds.includes(wf.id)
            ? "bg-[var(--app-active)]"
            : "bg-[var(--app-shell)]";
        const description = CRE_WORKFLOW_DESCRIPTIONS[wf.id];
        const isFlagship = wf.id === FLAGSHIP_WORKFLOW_ID;
        // Rows with a secondary description line need a touch more height than
        // the standard single-line row; everything else stays at h-10.
        const rowHeight = description ? "min-h-[3rem]" : "h-10";
        return (
            <div
                key={wf.id}
                onClick={() => setSelected(wf)}
                className={`group flex ${rowHeight} cursor-pointer items-center border-b border-[var(--app-border)] pr-3 transition-colors hover:bg-[var(--app-hover)] md:pr-10`}
            >
                <div
                    className={`sticky left-0 z-[60] ${CHECK_W} flex items-center justify-center self-stretch p-2 ${rowBg} group-hover:bg-[var(--app-panel-strong)]`}
                    onClick={(e) => e.stopPropagation()}
                >
                    <input
                        type="checkbox"
                        checked={selectedIds.includes(wf.id)}
                        onChange={() => toggleOne(wf.id)}
                        className="h-2.5 w-2.5 cursor-pointer rounded border-gray-200 accent-black"
                    />
                </div>
                <div className={`sticky left-8 z-[60] ${NAME_COL_W} self-stretch flex flex-col justify-center p-2 ${rowBg} group-hover:bg-[var(--app-panel-strong)]`}>
                    <span className="flex items-center gap-2">
                        <span className="block truncate text-sm text-[var(--app-text)]">
                            {wf.title}
                        </span>
                        {isFlagship && (
                            <span className="shrink-0 rounded-full bg-[var(--app-warm-soft)] px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-[var(--app-warm)]">
                                Flagship
                            </span>
                        )}
                    </span>
                    {description && (
                        <span className="mt-0.5 block truncate text-xs text-[var(--app-text-subtle)]">
                            {description}
                        </span>
                    )}
                </div>
                <div className="ml-auto w-28 shrink-0">
                    {(() => {
                        const { label, Icon, className } = getTypeMeta(wf.type);
                        return (
                            <span
                                className={`inline-flex items-center gap-1.5 text-xs font-medium ${className}`}
                            >
                                <Icon className="h-3.5 w-3.5" />
                                {label}
                            </span>
                        );
                    })()}
                </div>
                <div className="w-40 shrink-0">
                    {wf.practice ? (
                        <span className="text-xs font-medium text-[var(--app-text-muted)]">
                            {wf.practice}
                        </span>
                    ) : (
                        <span className="text-xs text-[var(--app-text-subtle)]">
                            —
                        </span>
                    )}
                </div>
                <div className="w-28 shrink-0">
                    {wf.is_system ? (
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--app-text-muted)]">
                            <CocoLegalIcon size={14} />
                            Coco Legal
                        </span>
                    ) : wf.user_id === user?.id ? (
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--app-text-muted)]">
                            <User className="h-3.5 w-3.5 text-[var(--app-text-subtle)]" />
                            Myself
                        </span>
                    ) : (
                        <span className="inline-flex max-w-full items-center gap-1.5 truncate text-xs font-medium text-[var(--app-text-muted)]">
                            <User className="h-3.5 w-3.5 shrink-0 text-[var(--app-text-subtle)]" />
                            <span className="truncate">
                                {wf.shared_by_name ?? "Shared"}
                            </span>
                        </span>
                    )}
                </div>
                <div
                    className="w-8 shrink-0 flex justify-end"
                    onClick={(e) => e.stopPropagation()}
                >
                    {wf.is_system ? (
                        activeTab === "hidden" ? (
                            <RowActions
                                onUnhide={() => handleUnhideWorkflow(wf.id)}
                            />
                        ) : (
                            <RowActions
                                onHide={() => handleHideWorkflow(wf.id)}
                            />
                        )
                    ) : wf.is_owner === false ? null : (
                        <RowActions
                            onDelete={async () => {
                                await deleteWorkflow(wf.id);
                                setCustom((prev) =>
                                    prev.filter((w) => w.id !== wf.id),
                                );
                            }}
                        />
                    )}
                </div>
            </div>
        );
    };

    const sectionHeader = (label: string) => (
        <div className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 md:px-10">
            {label}
        </div>
    );

    // On the All / Built-in tabs, surface the Commercial Real Estate suite as a
    // distinguished section above the rest. Other tabs render a flat list. The
    // UK lease pack is excluded from the CRE section for the US demo (it stays
    // defined and falls through to "All Playbooks").
    const grouped = activeTab === "all" || activeTab === "builtin";
    const isCreSectionRow = (wf: CocoLegalWorkflow) =>
        LEGAL_OPERATIONS_IDS.has(wf.id) && !HIDDEN_FROM_CRE_SECTION.has(wf.id);
    const creRows = grouped ? filtered.filter(isCreSectionRow) : [];
    const otherRows = grouped
        ? filtered.filter((wf) => !isCreSectionRow(wf))
        : filtered;

    return (
        <div className="flex flex-1 flex-col overflow-hidden bg-[var(--app-shell)] text-[var(--app-text)]">
            {/* Page header */}
            <div className="mb-1 flex items-center justify-between px-4 py-3 md:px-10 shrink-0">
                <div className="flex min-w-0 items-center gap-2">
                    <AppBackButton variant="dark" />
                    <h1 className="truncate text-2xl font-medium font-serif text-[var(--app-text-strong)]">
                        Playbooks & Workflows
                    </h1>
                </div>
                <div className="flex items-center gap-2">
                    <HeaderSearchBtn
                        value={search}
                        onChange={setSearch}
                        placeholder="Search playbooks…"
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
                onChange={(tab) => {
                    setActiveTab(tab);
                    resetSelection();
                }}
                variant="dark"
                actions={toolbarActions}
            />

            {/* Table */}
            <div className="flex-1 overflow-auto">
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
                                    className="h-2.5 w-2.5 cursor-pointer rounded border-gray-200 accent-black"
                                />
                            )}
                        </div>
                        <div className={`sticky left-8 z-[60] ${NAME_COL_W} bg-[var(--app-shell)] pl-2 text-left`}>
                            Name
                        </div>
                        <div className="ml-auto w-28 shrink-0">Type</div>
                        <div className="w-40 shrink-0">Practice</div>
                        <div className="w-28 shrink-0">Source</div>
                        <div className="w-8 shrink-0" />
                    </div>

                    {loading && activeTab !== "builtin" ? (
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
                                    <div className="w-28 shrink-0">
                                        <div className="h-3 w-16 animate-pulse rounded bg-[var(--app-active)]" />
                                    </div>
                                    <div className="w-40 shrink-0">
                                        <div className="h-3 w-24 animate-pulse rounded bg-[var(--app-active)]" />
                                    </div>
                                    <div className="w-28 shrink-0">
                                        <div className="h-3 w-14 animate-pulse rounded bg-[var(--app-active)]" />
                                    </div>
                                    <div className="w-8 shrink-0" />
                                </div>
                            ))}
                        </div>
                    ) : filtered.length === 0 ? (
                        <div className="flex flex-col items-start py-24 w-full max-w-xs mx-auto">
                            {activeTab === "custom" ? (
                                <>
                                    <Library className="mb-4 h-8 w-8 text-[var(--app-text-subtle)]" />
                                    <p className="font-serif text-2xl font-medium text-[var(--app-text-strong)]">
                                        Custom Playbooks
                                    </p>
                                    <p className="mt-1 text-left text-xs text-[var(--app-text-subtle)]">
                                        Build reusable prompts and tabular
                                        review playbooks tailored to your
                                        practice.
                                    </p>
                                    <button
                                        onClick={() => setNewModalOpen(true)}
                                        className="mt-4 inline-flex items-center gap-1 rounded-full bg-[var(--app-active-strong)] px-3 py-1 text-xs font-medium text-[var(--app-active-foreground)] shadow-md transition-colors hover:opacity-90"
                                    >
                                        + Create New
                                    </button>
                                </>
                            ) : activeTab === "hidden" ? (
                                <>
                                    <Library className="mb-4 h-8 w-8 text-[var(--app-text-subtle)]" />
                                    <p className="font-serif text-2xl font-medium text-[var(--app-text-strong)]">
                                        Hidden Playbooks
                                    </p>
                                    <p className="mt-1 text-left text-xs text-[var(--app-text-subtle)]">
                                        Built-in playbooks you&apos;ve hidden will
                                        appear here. You can unhide them at any
                                        time.
                                    </p>
                                </>
                            ) : (
                                <>
                                    <Library className="mb-4 h-8 w-8 text-[var(--app-text-subtle)]" />
                                    <p className="font-serif text-2xl font-medium text-[var(--app-text-strong)]">
                                        Playbooks & Workflows
                                    </p>
                                    <p className="mt-1 text-left text-xs text-[var(--app-text-subtle)]">
                                        Automate document analysis with reusable
                                        prompts and review table templates.
                                    </p>
                                </>
                            )}
                        </div>
                    ) : (
                        <>
                            {creRows.length > 0 && (
                                <>
                                    {sectionHeader("Commercial Real Estate")}
                                    {creRows.map(renderWorkflowRow)}
                                </>
                            )}
                            {creRows.length > 0 && otherRows.length > 0 &&
                                sectionHeader("All Playbooks")}
                            {otherRows.map(renderWorkflowRow)}
                        </>
                    )}
                </div>
            </div>

            <DisplayWorkflowModal
                workflows={all}
                workflow={selected}
                onClose={() => setSelected(null)}
            />

            <NewWorkflowModal
                open={newModalOpen}
                onClose={() => setNewModalOpen(false)}
                onCreated={(wf) => {
                    setCustom((prev) => [wf, ...prev]);
                    setNewModalOpen(false);
                    router.push(`/workflows/${wf.id}`);
                }}
            />
        </div>
    );
}
