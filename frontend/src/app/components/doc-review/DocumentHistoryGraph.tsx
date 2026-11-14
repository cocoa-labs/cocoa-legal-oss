"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { GitBranch, Loader2, MessageSquareText } from "lucide-react";
import {
    getVersionGraph,
    type VersionGraphForkNode,
    type VersionGraphNode,
} from "@/app/lib/cocoaLegalApi";
import { matterDocReviewHref } from "@/app/lib/matterRoutes";
import { MatterNav } from "@/app/components/projects/MatterNav";

const ROW_H = 54;
const COL_W = 40;
const NODE_R = 7;
const PAD_X = 22;
const PAD_Y = 22;
const LABEL_W = 340;

interface Props {
    projectId: string;
}

type DocGroup = {
    documentId: string;
    filename: string;
    nodes: VersionGraphNode[];
    forks: VersionGraphForkNode[];
};

function sortNodes(nodes: VersionGraphNode[]): VersionGraphNode[] {
    return [...nodes].sort((a, b) => {
        const ta = a.created_at ? Date.parse(a.created_at) : 0;
        const tb = b.created_at ? Date.parse(b.created_at) : 0;
        if (ta !== tb) return ta - tb;
        return (a.version_number ?? 0) - (b.version_number ?? 0);
    });
}

// Standard git-graph column assignment: a node continues its parent's column
// when that parent is still a column tip; when the parent already has a child
// (a branch) or has no visible parent, the node opens the next free column.
function computeColumns(sorted: VersionGraphNode[]): {
    col: Map<string, number>;
    maxCol: number;
} {
    const col = new Map<string, number>();
    const tips: (string | null)[] = [];
    for (const n of sorted) {
        let placed = -1;
        if (n.parent_version_id) {
            const c = tips.findIndex((t) => t === n.parent_version_id);
            if (c >= 0) {
                tips[c] = n.id;
                placed = c;
            }
        }
        if (placed < 0) {
            const free = tips.findIndex((t) => t === null);
            if (free >= 0) {
                tips[free] = n.id;
                placed = free;
            } else {
                tips.push(n.id);
                placed = tips.length - 1;
            }
        }
        col.set(n.id, placed);
    }
    return { col, maxCol: Math.max(0, tips.length - 1) };
}

function edgePath(x1: number, y1: number, x2: number, y2: number): string {
    if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`;
    const my = (y1 + y2) / 2;
    return `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
}

function sourceColor(source: string, isCurrent: boolean): string {
    if (isCurrent) return "var(--app-accent)";
    if (source === "assistant_edit") return "#60a5fa";
    if (source === "generated" || source === "clean_final") return "#34d399";
    if (source === "upload" || source === "user_upload") return "#94a3b8";
    return "#a78bfa";
}

function sourceLabel(source: string): string {
    switch (source) {
        case "upload":
        case "user_upload":
            return "upload";
        case "assistant_edit":
            return "assistant edit";
        case "assistant_highlight":
            return "highlights";
        case "generated":
            return "generated";
        case "clean_final":
            return "clean copy";
        default:
            return source.replace(/_/g, " ");
    }
}

export function DocumentHistoryGraph({ projectId }: Props) {
    const router = useRouter();
    // The fetch result, TAGGED with the projectId it answers for. loading /
    // graph / error all derive from whether the tag matches the current prop,
    // so a projectId change needs no setLoading(true)-in-effect: the stale
    // result simply stops matching and the spinner state falls out of the
    // derivation. (Also closes two latent gaps in the old three-state shape:
    // a stale error or graph from a previous matter can no longer linger
    // beneath the spinner after navigation.)
    const [fetched, setFetched] = useState<{
        projectId: string;
        graph: {
            version_nodes: VersionGraphNode[];
            fork_nodes: VersionGraphForkNode[];
        } | null;
        error: string | null;
    } | null>(null);

    useEffect(() => {
        let alive = true;
        getVersionGraph(projectId)
            .then((g) => {
                if (alive) setFetched({ projectId, graph: g, error: null });
            })
            .catch((e) => {
                if (alive)
                    setFetched({
                        projectId,
                        graph: null,
                        error:
                            e instanceof Error ? e.message : "Failed to load",
                    });
            });
        return () => {
            alive = false;
        };
    }, [projectId]);

    const current =
        fetched !== null && fetched.projectId === projectId ? fetched : null;
    const graph = current?.graph ?? null;
    const error = current?.error ?? null;
    const loading = current === null;

    const groups = useMemo<DocGroup[]>(() => {
        if (!graph) return [];
        const byDoc = new Map<string, DocGroup>();
        for (const n of graph.version_nodes) {
            const g = byDoc.get(n.document_id) ?? {
                documentId: n.document_id,
                filename: n.filename ?? "Document",
                nodes: [],
                forks: [],
            };
            g.nodes.push(n);
            byDoc.set(n.document_id, g);
        }
        // Attach forks to the document their anchor version belongs to.
        const docByVersion = new Map<string, string>();
        for (const n of graph.version_nodes)
            docByVersion.set(n.id, n.document_id);
        for (const f of graph.fork_nodes) {
            const docId = f.anchor_version_id
                ? docByVersion.get(f.anchor_version_id)
                : undefined;
            if (docId && byDoc.has(docId)) byDoc.get(docId)!.forks.push(f);
        }
        // Only documents with a real history (>1 version or a fork) are worth
        // graphing; single-upload docs would just be a lone dot.
        return Array.from(byDoc.values()).filter(
            (g) => g.nodes.length > 1 || g.forks.length > 0,
        );
    }, [graph]);

    const goToConversation = (node: VersionGraphNode) => {
        const chatId = node.provenance?.chat_id ?? null;
        router.push(
            chatId
                ? `/projects/${projectId}/doc-review/chat/${chatId}`
                : matterDocReviewHref(projectId),
        );
    };

    return (
        <div className="flex h-full flex-col bg-[var(--app-bg)] text-[var(--app-text-strong)]">
            <div className="shrink-0 bg-[var(--app-shell-subtle)] px-4 md:px-8">
                <MatterNav
                    projectId={projectId}
                    active="history"
                    variant="dark"
                />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <div className="mb-4 flex items-center gap-2">
                <GitBranch className="h-5 w-5 text-[var(--app-accent)]" />
                <h1 className="text-lg font-medium">History</h1>
                <span className="text-sm text-[var(--app-text-muted)]">
                    — versions &amp; the conversations that shaped them
                </span>
            </div>

            <div className="mb-4 flex flex-wrap items-center gap-4 text-[11px] text-[var(--app-text-muted)]">
                <Legend color="var(--app-accent)" label="current version" />
                <Legend color="#60a5fa" label="assistant edit" />
                <Legend color="#34d399" label="generated / clean copy" />
                <Legend color="#94a3b8" label="upload" />
                <span className="inline-flex items-center gap-1">
                    <svg width="22" height="8">
                        <line
                            x1="0"
                            y1="4"
                            x2="22"
                            y2="4"
                            stroke="var(--app-accent)"
                            strokeWidth="2"
                            strokeDasharray="3 3"
                        />
                    </svg>
                    conversation fork
                </span>
            </div>

            {loading && (
                <div className="flex items-center gap-2 text-sm text-[var(--app-text-muted)]">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading history…
                </div>
            )}
            {error && !loading && (
                <div className="text-sm text-red-400">{error}</div>
            )}
            {!loading && !error && groups.length === 0 && (
                <div className="text-sm text-[var(--app-text-muted)]">
                    No version history yet. Edit a document or fork a
                    conversation and it will appear here.
                </div>
            )}

            <div className="space-y-5">
                {groups.map((group) => (
                    <DocGraphCard
                        key={group.documentId}
                        group={group}
                        onNodeClick={goToConversation}
                        onForkClick={(f) =>
                            router.push(
                                `/projects/${projectId}/doc-review/chat/${f.chat_id}`,
                            )
                        }
                    />
                ))}
            </div>
            </div>
        </div>
    );
}

function Legend({ color, label }: { color: string; label: string }) {
    return (
        <span className="inline-flex items-center gap-1.5">
            <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: color }}
            />
            {label}
        </span>
    );
}

function DocGraphCard({
    group,
    onNodeClick,
    onForkClick,
}: {
    group: DocGroup;
    onNodeClick: (node: VersionGraphNode) => void;
    onForkClick: (fork: VersionGraphForkNode) => void;
}) {
    const sorted = useMemo(() => sortNodes(group.nodes), [group.nodes]);
    const { col, maxCol } = useMemo(() => computeColumns(sorted), [sorted]);
    const rowOf = useMemo(() => {
        const m = new Map<string, number>();
        sorted.forEach((n, i) => m.set(n.id, i));
        return m;
    }, [sorted]);

    const pos = (id: string) => ({
        x: PAD_X + (col.get(id) ?? 0) * COL_W,
        y: PAD_Y + (rowOf.get(id) ?? 0) * ROW_H,
    });

    const idSet = useMemo(() => new Set(sorted.map((n) => n.id)), [sorted]);
    const width = PAD_X * 2 + maxCol * COL_W + LABEL_W;
    const height = PAD_Y * 2 + Math.max(0, sorted.length - 1) * ROW_H;

    return (
        <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-4">
            <div className="mb-1 truncate text-sm font-medium">
                {group.filename}
            </div>
            <svg
                width={width}
                height={height + PAD_Y}
                className="overflow-visible"
            >
                {/* lineage edges (parent → child) */}
                {sorted.map((n) =>
                    n.parent_version_id && idSet.has(n.parent_version_id) ? (
                        <path
                            key={`l-${n.id}`}
                            d={edgePath(
                                pos(n.parent_version_id).x,
                                pos(n.parent_version_id).y,
                                pos(n.id).x,
                                pos(n.id).y,
                            )}
                            fill="none"
                            stroke="var(--app-border)"
                            strokeWidth={2}
                        />
                    ) : null,
                )}
                {/* fork edges (anchor → branch tip), dashed */}
                {group.forks.map((f) =>
                    f.anchor_version_id &&
                    f.branch_tip_version_id &&
                    f.anchor_version_id !== f.branch_tip_version_id &&
                    idSet.has(f.anchor_version_id) &&
                    idSet.has(f.branch_tip_version_id) ? (
                        <path
                            key={`f-${f.chat_id}`}
                            d={edgePath(
                                pos(f.anchor_version_id).x,
                                pos(f.anchor_version_id).y,
                                pos(f.branch_tip_version_id).x,
                                pos(f.branch_tip_version_id).y,
                            )}
                            fill="none"
                            stroke="var(--app-accent)"
                            strokeWidth={2}
                            strokeDasharray="3 3"
                        />
                    ) : null,
                )}
                {/* version nodes + labels */}
                {sorted.map((n) => {
                    const p = pos(n.id);
                    const color = sourceColor(n.source, n.is_current);
                    const hasChat = !!n.provenance?.chat_id;
                    const labelX = PAD_X + maxCol * COL_W + 18;
                    return (
                        <g
                            key={n.id}
                            className="cursor-pointer"
                            onClick={() => onNodeClick(n)}
                        >
                            <title>
                                {`${
                                    n.version_number
                                        ? `V${n.version_number} · `
                                        : ""
                                }${sourceLabel(n.source)}${
                                    hasChat
                                        ? " · click to open the conversation"
                                        : ""
                                }`}
                            </title>
                            <circle
                                cx={p.x}
                                cy={p.y}
                                r={NODE_R}
                                fill={color}
                                stroke="var(--app-panel)"
                                strokeWidth={2}
                            />
                            {n.is_current && (
                                <circle
                                    cx={p.x}
                                    cy={p.y}
                                    r={NODE_R + 3}
                                    fill="none"
                                    stroke={color}
                                    strokeWidth={1.5}
                                />
                            )}
                            <text
                                x={labelX}
                                y={p.y - 2}
                                className="fill-[var(--app-text-strong)] text-[12px]"
                            >
                                {n.version_number
                                    ? `V${n.version_number}`
                                    : sourceLabel(n.source)}
                                {n.is_current ? "  (current)" : ""}
                            </text>
                            <text
                                x={labelX}
                                y={p.y + 12}
                                className="fill-[var(--app-text-muted)] text-[10px]"
                            >
                                {sourceLabel(n.source)}
                                {hasChat ? "  ·  from a conversation" : ""}
                            </text>
                            {hasChat && (
                                <MessageSquareText
                                    x={labelX - 16}
                                    y={p.y - 7}
                                    width={11}
                                    height={11}
                                    className="text-[var(--app-text-subtle)]"
                                />
                            )}
                        </g>
                    );
                })}
            </svg>

            {group.forks.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2 border-t border-[var(--app-border)] pt-2">
                    {group.forks.map((f) => (
                        <button
                            key={f.chat_id}
                            type="button"
                            onClick={() => onForkClick(f)}
                            title="Open this conversation branch"
                            className="inline-flex items-center gap-1 rounded-md border border-[var(--app-accent)]/40 bg-[var(--app-accent)]/10 px-2 py-0.5 text-[11px] text-[var(--app-text-muted)] hover:text-[var(--app-text-strong)]"
                        >
                            <GitBranch className="h-3 w-3 text-[var(--app-accent)]" />
                            {f.fork_label || f.title || "Branch"}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
