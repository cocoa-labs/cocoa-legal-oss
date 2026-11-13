"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
    Activity,
    AlertTriangle,
    ArrowUpRight,
    BookOpenCheck,
    Bot,
    CheckCircle2,
    ChevronDown,
    CircleDot,
    Clock3,
    FileText,
    Gauge,
    LayoutDashboard,
    Loader2,
    MessageSquareText,
    Paperclip,
    Plus,
    RefreshCw,
    Search,
    Send,
    ShieldCheck,
    Sparkles,
    Table2,
    Upload,
    Wand2,
} from "lucide-react";
import {
    getChat,
    getProject,
    getTabularReview,
    listProjectChats,
    listTabularReviews,
} from "@/app/lib/cocoLegalApi";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { AppBackButton } from "@/app/components/shared/AppBackButton";
import { DocPanel } from "@/app/components/shared/DocPanel";
import { MatterNav } from "@/app/components/projects/MatterNav";
import { OperationActivityPanel } from "@/app/components/assistant/OperationActivityPanel";
import { MatterUpcomingEvents } from "@/app/components/calendar/MatterUpcomingEvents";
import {
    matterDocReviewHref,
    matterDocumentsHref,
    matterReviewsHref,
    matterWorkflowsHref,
} from "@/app/lib/matterRoutes";
import type {
    AssistantEvent,
    CocoLegalChat,
    CocoLegalChatDetailOut,
    CocoLegalCitationAnnotation,
    CocoLegalDocument,
    CocoLegalEditAnnotation,
    CocoLegalMessage,
    CocoLegalProject,
    TabularReview,
    TabularReviewDetailOut,
} from "@/app/components/shared/types";

type AgentId =
    | "reviewer"
    | "drafter"
    | "extractor"
    | "redliner"
    | "matter-analyst";

type AgentStatus = "Running" | "Ready" | "Completed" | "Pending Approval";

type AgentModel = {
    id: AgentId;
    label: string;
    initial: string;
    status: AgentStatus;
    summary: string;
    actionLabel: string;
    href?: string;
};

type ExtractionRow = {
    field: string;
    value: string;
    source: string;
    status: string;
};

const AGENT_ACCENTS: Record<AgentId, string> = {
    reviewer: "from-sky-500 to-cyan-300",
    drafter: "from-emerald-500 to-lime-300",
    extractor: "from-teal-500 to-cyan-300",
    redliner: "from-amber-500 to-orange-300",
    "matter-analyst": "from-blue-500 to-indigo-300",
};

const AGENT_PROMPTS: Record<AgentId, string> = {
    reviewer:
        "Review the matter documents for the key legal and commercial points. Ground the answer in citations and flag anything unusual.",
    drafter:
        "Draft the next legal document needed for this transaction using the matter documents as context.",
    extractor:
        "Extract the core transaction terms into a structured review table, including parties, facilities, covenants, dates, and status items.",
    redliner:
        "Review pending redline opportunities in the matter documents and propose precise tracked changes where market or drafting improvements are needed.",
    "matter-analyst":
        "Analyze this matter's risk, completion status, missing documents, and next recommended actions.",
};

function formatDate(iso?: string | null) {
    if (!iso) return "Not set";
    const dt = new Date(iso);
    if (Number.isNaN(dt.valueOf())) return "Not set";
    return dt.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
    });
}

function formatMoneyLabel(value?: string | null) {
    if (!value) return "Not set";
    return value;
}

function docTypeLabel(doc?: CocoLegalDocument | null) {
    if (!doc?.file_type) return "Document";
    return doc.file_type.toUpperCase();
}

function summarizeCell(value?: string | null) {
    const trimmed = value?.replace(/\s+/g, " ").trim() ?? "";
    if (!trimmed) return "Awaiting extraction";
    return trimmed.length > 90 ? `${trimmed.slice(0, 87)}...` : trimmed;
}

function messageText(message: CocoLegalMessage) {
    if (message.content?.trim()) return message.content.trim();
    const events = message.events ?? [];
    return events
        .filter((event) => event.type === "content")
        .map((event) => (event as Extract<AssistantEvent, { type: "content" }>).text)
        .join("")
        .trim();
}

function collectCitations(messages: CocoLegalMessage[]): CocoLegalCitationAnnotation[] {
    return messages.flatMap((message) => message.annotations ?? []);
}

function citationChipKey(citation: CocoLegalCitationAnnotation, index: number) {
    return [
        citation.ref ?? "no-ref",
        citation.document_id ?? citation.doc_id ?? "no-doc",
        citation.version_id ?? "no-version",
        citation.page ?? "no-page",
        index,
    ].join("-");
}

function citationChipLabel(citation: CocoLegalCitationAnnotation) {
    const filename = citation.filename || "Citation";
    const page = citation.page ? ` p.${citation.page}` : "";
    return `${filename}${page}`;
}

function collectPendingEdits(messages: CocoLegalMessage[]): CocoLegalEditAnnotation[] {
    const edits: CocoLegalEditAnnotation[] = [];
    for (const message of messages) {
        for (const event of message.events ?? []) {
            if (event.type !== "doc_edited") continue;
            for (const annotation of event.annotations ?? []) {
                if (annotation.status === "pending") edits.push(annotation);
            }
        }
    }
    return edits;
}

function latestAssistantMessages(messages: CocoLegalMessage[]) {
    return messages
        .filter((message) => message.role === "assistant" && messageText(message))
        .slice(-3)
        .reverse();
}

function buildExtractionRows(
    detail: TabularReviewDetailOut | null,
    preferredDocumentId?: string | null,
): ExtractionRow[] {
    if (!detail?.review.columns_config?.length) return [];
    const docs = detail.documents;
    const activeDoc =
        docs.find((doc) => doc.id === preferredDocumentId) ?? docs[0] ?? null;
    if (!activeDoc) return [];

    const cellsByColumn = new Map(
        detail.cells
            .filter((cell) => cell.document_id === activeDoc.id)
            .map((cell) => [cell.column_index, cell]),
    );

    return detail.review.columns_config.slice(0, 9).map((column) => {
        const cell = cellsByColumn.get(column.index);
        return {
            field: column.name,
            value: summarizeCell(cell?.content?.summary ?? null),
            source:
                cell?.content?.summary && activeDoc.filename
                    ? activeDoc.filename
                    : "No source yet",
            status: cell?.status ?? "pending",
        };
    });
}

function CocoMark() {
    return (
        <div className="flex items-center gap-3">
            <div className="relative flex h-8 w-8 items-center justify-center rounded-lg border border-cyan-300/40 bg-cyan-300/10 shadow-[0_0_28px_rgba(34,211,238,0.22)]">
                <div className="h-3.5 w-3.5 rotate-45 rounded-[3px] border border-white/90" />
                <div className="absolute h-1.5 w-1.5 rounded-full bg-cyan-300" />
            </div>
            <span className="text-lg font-semibold tracking-normal text-[var(--app-text-strong)]">
                Coco Legal
            </span>
        </div>
    );
}

function StatusDot({ status }: { status: AgentStatus }) {
    const color =
        status === "Completed"
            ? "bg-emerald-400"
            : status === "Pending Approval"
              ? "bg-amber-400"
              : status === "Running"
                ? "bg-cyan-400"
                : "bg-slate-400";
    return <span className={`h-2 w-2 rounded-full ${color}`} />;
}

function AgentAvatar({ agent }: { agent: AgentModel }) {
    return (
        <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${AGENT_ACCENTS[agent.id]} text-sm font-bold text-slate-950 shadow-[0_0_24px_rgba(14,165,233,0.2)]`}
        >
            {agent.initial}
        </div>
    );
}

function EmptyPanel({
    icon: Icon,
    title,
    body,
    action,
}: {
    icon: typeof FileText;
    title: string;
    body: string;
    action?: React.ReactNode;
}) {
    return (
        <div className="flex h-full min-h-[280px] flex-col items-center justify-center gap-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-soft)] p-8 text-center">
            <Icon className="h-8 w-8 text-[var(--app-text-subtle)]" />
            <div>
                <p className="text-sm font-semibold text-[var(--app-text-strong)]">{title}</p>
                <p className="mt-1 max-w-sm text-xs leading-5 text-[var(--app-text-muted)]">
                    {body}
                </p>
            </div>
            {action}
        </div>
    );
}

function WorkspaceSkeleton() {
    return (
        <div className="flex h-full min-h-[720px] bg-[var(--app-shell)] p-4 text-[var(--app-text)]">
            <div className="h-full w-full animate-pulse rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)]" />
        </div>
    );
}

export function CocoWorkspace({ projectId }: { projectId: string }) {
    const router = useRouter();
    const { saveChat, setNewChatMessages } = useChatHistoryContext();
    const [isPending, startTransition] = useTransition();

    const [project, setProject] = useState<CocoLegalProject | null>(null);
    const [chats, setChats] = useState<CocoLegalChat[]>([]);
    const [reviews, setReviews] = useState<TabularReview[]>([]);
    const [chatDetail, setChatDetail] = useState<CocoLegalChatDetailOut | null>(null);
    const [reviewDetail, setReviewDetail] =
        useState<TabularReviewDetailOut | null>(null);
    const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
    const [selectedReviewId, setSelectedReviewId] = useState<string | null>(
        null,
    );
    const [selectedAgent, setSelectedAgent] = useState<AgentId>("reviewer");
    const [command, setCommand] = useState("");
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        Promise.all([
            getProject(projectId),
            listProjectChats(projectId).catch(() => [] as CocoLegalChat[]),
            listTabularReviews(projectId).catch(() => [] as TabularReview[]),
        ])
            .then(([loadedProject, loadedChats, loadedReviews]) => {
                if (cancelled) return;
                setProject(loadedProject);
                setChats(loadedChats);
                setReviews(loadedReviews);
                const readyDoc =
                    loadedProject.documents?.find(
                        (doc) => doc.status === "ready",
                    ) ??
                    loadedProject.documents?.[0] ??
                    null;
                setSelectedDocId((prev) => prev ?? readyDoc?.id ?? null);
                setSelectedReviewId((prev) => prev ?? loadedReviews[0]?.id ?? null);
            })
            .catch((error) => {
                if (cancelled) return;
                setLoadError(
                    error instanceof Error
                        ? error.message
                        : "Could not load workspace.",
                );
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [projectId]);

    useEffect(() => {
        let cancelled = false;
        const latestChat = chats[0];
        if (!latestChat) {
            void Promise.resolve().then(() => {
                if (!cancelled) setChatDetail(null);
            });
            return;
        }
        getChat(latestChat.id)
            .then((detail) => {
                if (!cancelled) setChatDetail(detail);
            })
            .catch(() => {
                if (!cancelled) setChatDetail(null);
            });
        return () => {
            cancelled = true;
        };
    }, [chats]);

    useEffect(() => {
        let cancelled = false;
        if (!selectedReviewId) {
            void Promise.resolve().then(() => {
                if (!cancelled) setReviewDetail(null);
            });
            return;
        }
        getTabularReview(selectedReviewId)
            .then((detail) => {
                if (!cancelled) setReviewDetail(detail);
            })
            .catch(() => {
                if (!cancelled) setReviewDetail(null);
            });
        return () => {
            cancelled = true;
        };
    }, [selectedReviewId]);

    const docs = useMemo(
        () => [...(project?.documents ?? [])].sort((a, b) => {
            const aTime = Date.parse(a.updated_at ?? a.created_at ?? "");
            const bTime = Date.parse(b.updated_at ?? b.created_at ?? "");
            return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
        }),
        [project?.documents],
    );

    const selectedDoc =
        docs.find((doc) => doc.id === selectedDocId) ?? docs[0] ?? null;
    const messages = chatDetail?.messages ?? [];
    const citations = collectCitations(messages);
    const pendingEdits = collectPendingEdits(messages);
    const assistantMessages = latestAssistantMessages(messages);
    const extractionRows = buildExtractionRows(reviewDetail, selectedDoc?.id);
    const completedCells =
        reviewDetail?.cells.filter((cell) => cell.status === "done").length ?? 0;
    const totalCells = reviewDetail?.cells.length ?? 0;
    const completionPct =
        totalCells > 0 ? Math.round((completedCells / totalCells) * 100) : 0;
    const readyDocs = docs.filter((doc) => doc.status === "ready").length;

    const agents: AgentModel[] = [
        {
            id: "reviewer",
            label: "Reviewer",
            initial: "R",
            status: messages.length > 0 ? "Completed" : "Running",
            summary:
                citations.length > 0
                    ? `Completed summary with ${citations.length} citations.`
                    : "Ready to review matter documents with citations.",
            actionLabel: messages.length > 0 ? "View Summary" : "Ask Reviewer",
            href: chats[0]
                ? `/projects/${projectId}/doc-review/chat/${chats[0].id}`
                : matterDocReviewHref(projectId),
        },
        {
            id: "drafter",
            label: "Drafter",
            initial: "D",
            status: "Ready",
            summary: "Drafting queue ready for transaction documents.",
            actionLabel: "Start Draft",
            href: matterDocReviewHref(projectId),
        },
        {
            id: "extractor",
            label: "Extractor",
            initial: "E",
            status: completedCells > 0 ? "Completed" : "Ready",
            summary:
                completedCells > 0
                    ? `Extracted ${completedCells} terms across ${reviewDetail?.documents.length ?? 0} documents.`
                    : "Ready to populate transaction review tables.",
            actionLabel: completedCells > 0 ? "View Results" : "Create Review",
            href: selectedReviewId
                ? `/projects/${projectId}/tabular-reviews/${selectedReviewId}`
                : matterReviewsHref(projectId),
        },
        {
            id: "redliner",
            label: "Redliner",
            initial: "L",
            status: pendingEdits.length > 0 ? "Pending Approval" : "Ready",
            summary:
                pendingEdits.length > 0
                    ? `${pendingEdits.length} proposed change${pendingEdits.length === 1 ? "" : "s"} waiting for review.`
                    : "No unresolved redlines detected.",
            actionLabel:
                pendingEdits.length > 0 ? "Review Change" : "Ask Redliner",
            href: chats[0]
                ? `/projects/${projectId}/doc-review/chat/${chats[0].id}`
                : matterDocReviewHref(projectId),
        },
        {
            id: "matter-analyst",
            label: "Matter Analyst",
            initial: "M",
            status: "Running",
            summary: `Analyzing ${docs.length} document${docs.length === 1 ? "" : "s"} and ${reviews.length} review${reviews.length === 1 ? "" : "s"}.`,
            actionLabel: "View Analysis",
            href: `/projects/${projectId}/assistant`,
        },
    ];

    const selectedAgentModel =
        agents.find((agent) => agent.id === selectedAgent) ?? agents[0];

    async function startAgentTask(promptOverride?: string) {
        const prompt = (promptOverride ?? command).trim();
        const content = prompt || AGENT_PROMPTS[selectedAgent];
        startTransition(async () => {
            const chatId = await saveChat(projectId);
            if (!chatId) return;
            setNewChatMessages([
                {
                    role: "user",
                    content,
                },
            ]);
            router.push(`/projects/${projectId}/doc-review/chat/${chatId}`);
        });
    }

    if (loading) return <WorkspaceSkeleton />;

    if (loadError || !project) {
        return (
            <div className="flex h-full min-h-[720px] items-center justify-center bg-slate-950 p-6 text-slate-100">
                <EmptyPanel
                    icon={AlertTriangle}
                    title="Workspace could not load"
                    body={loadError ?? "The matter is unavailable or access changed."}
                    action={
                        <Link
                            href="/projects"
                            className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-medium text-slate-200 hover:border-cyan-300/60 hover:text-white"
                        >
                            Back to matters
                        </Link>
                    }
                />
            </div>
        );
    }

    return (
        <div className="flex h-full min-h-[760px] overflow-hidden bg-[var(--app-shell)] text-[var(--app-text)]">
            <aside className="hidden w-[228px] shrink-0 flex-col border-r border-[var(--app-border)] bg-[var(--app-sidebar)] p-4 lg:flex">
                <CocoMark />
                <button className="mt-8 flex h-10 items-center justify-between rounded-lg bg-blue-600 px-3 text-sm font-medium text-white shadow-[0_0_28px_rgba(37,99,235,0.35)]">
                    <span className="flex items-center gap-2">
                        <Plus className="h-4 w-4" />
                        New
                    </span>
                    <ChevronDown className="h-4 w-4" />
                </button>
                <nav className="mt-6 space-y-1 text-sm text-[var(--app-text-muted)]">
                    {[
                        ["Doc Review", MessageSquareText, matterDocReviewHref(projectId)],
                        ["Matters", FileText, "/projects"],
                        ["Review Tables", Table2, matterReviewsHref(projectId)],
                        ["Agents", Bot, `/projects/${projectId}/workspace`],
                        ["Playbooks", Wand2, matterWorkflowsHref()],
                    ].map(([label, Icon, href]) => (
                        <Link
                            key={label as string}
                            href={href as string}
                            className={`flex items-center gap-3 rounded-lg px-3 py-2 transition ${
                                label === "Agents"
                                    ? "bg-[var(--app-accent-soft)] text-[var(--app-text-strong)] ring-1 ring-[var(--app-border-strong)]"
                                    : "hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                            }`}
                        >
                            <Icon className="h-4 w-4" />
                            {label as string}
                        </Link>
                    ))}
                </nav>
                <div className="mt-8 border-t border-[var(--app-border)] pt-5">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--app-text-subtle)]">
                        Recent matters
                    </p>
                    <div className="mt-3 space-y-1.5">
                        {[project.name, "Acme Credit Facility", "Example Term Loan Refi", "Sample Co. LBO"].map(
                            (matter, index) => (
                                <button
                                    key={matter}
                                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs ${
                                        index === 0
                                            ? "bg-[var(--app-active)] text-[var(--app-text-strong)]"
                                            : "text-[var(--app-text-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text)]"
                                    }`}
                                >
                                    <FileText className="h-3.5 w-3.5 shrink-0" />
                                    <span className="truncate">{matter}</span>
                                    {index === 0 && (
                                        <span className="ml-auto h-1.5 w-1.5 rounded-full bg-cyan-300" />
                                    )}
                                </button>
                            ),
                        )}
                    </div>
                </div>
                <div className="mt-auto flex items-center gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-command-muted)] p-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500 text-xs font-bold text-slate-950">
                        CA
                    </div>
                    <div className="min-w-0">
                        <p className="truncate text-xs font-medium text-[var(--app-text-strong)]">
                            Coco Legal
                        </p>
                        <p className="text-[11px] text-[var(--app-text-subtle)]">Pilot workspace</p>
                    </div>
                </div>
            </aside>

            <main className="flex min-w-0 flex-1 flex-col">
                <header className="shrink-0 border-b border-[var(--app-border)] bg-[var(--app-panel)] px-4 py-4 md:px-6">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                        <div className="flex min-w-0 items-start gap-2">
                            <AppBackButton variant="dark" className="mt-0.5" />
                            <div className="min-w-0">
                                <div className="flex items-center gap-2 text-xs text-[var(--app-text-muted)]">
                                    <Link href="/projects" className="hover:text-[var(--app-text-strong)]">
                                        Matters
                                    </Link>
                                    <span>/</span>
                                    <span className="truncate">{project.name}</span>
                                </div>
                                <div className="mt-2 flex items-center gap-3">
                                    <h1 className="truncate text-2xl font-semibold tracking-normal text-[var(--app-text-strong)] md:text-3xl">
                                        {project.name}
                                    </h1>
                                    <Link
                                        href={matterDocumentsHref(projectId)}
                                        className="rounded-lg border border-[var(--app-border)] px-2 py-1 text-[11px] font-medium text-[var(--app-text-muted)] hover:border-[var(--app-border-strong)] hover:text-[var(--app-text-strong)]"
                                    >
                                        Documents
                                    </Link>
                                </div>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            {[
                                ["Upload", Upload, matterDocumentsHref(projectId)],
                                ["Ask", MessageSquareText, matterDocReviewHref(projectId)],
                                ["Review", Table2, selectedReviewId ? `/projects/${projectId}/tabular-reviews/${selectedReviewId}` : matterReviewsHref(projectId)],
                                ["Playbook", BookOpenCheck, matterWorkflowsHref()],
                                ["Activity", Activity, "#activity"],
                            ].map(([label, Icon, href]) => (
                                <Link
                                    key={label as string}
                                    href={href as string}
                                    className="flex h-9 items-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-command-muted)] px-3 text-xs font-medium text-[var(--app-text-muted)] hover:border-[var(--app-border-strong)] hover:text-[var(--app-text-strong)]"
                                    title={label as string}
                                >
                                    <Icon className="h-4 w-4" />
                                    <span className="hidden sm:inline">
                                        {label as string}
                                    </span>
                                </Link>
                            ))}
                        </div>
                    </div>
                    <div className="mt-4 grid gap-3 text-xs text-[var(--app-text-muted)] sm:grid-cols-2 xl:grid-cols-5">
                        <Metric label="Status" value="In Progress" tone="blue" />
                        <Metric
                            label="Matter type"
                            value={project.cm_number ? `CM ${project.cm_number}` : "Transactional review"}
                        />
                        <Metric label="Value" value={formatMoneyLabel(null)} />
                        <Metric
                            label="Documents"
                            value={`${readyDocs}/${docs.length} ready`}
                            tone={readyDocs === docs.length ? "green" : "amber"}
                        />
                        <Metric label="Latest activity" value={formatDate(chats[0]?.created_at)} />
                    </div>
                    <div className="mt-4">
                        <MatterNav
                            projectId={projectId}
                            active="command"
                            variant="dark"
                        />
                    </div>
                </header>

                <section className="shrink-0 border-b border-[var(--app-border)] bg-[var(--app-panel)] px-4 py-3 md:px-6">
                    <div className="flex gap-3 overflow-x-auto pb-1">
                        {agents.map((agent) => (
                            <button
                                key={agent.id}
                                onClick={() => setSelectedAgent(agent.id)}
                                className={`flex min-w-[168px] items-center gap-3 rounded-lg border px-3 py-2 text-left transition ${
                                    selectedAgent === agent.id
                                        ? "border-[var(--app-border-strong)] bg-[var(--app-accent-soft)]"
                                        : "border-[var(--app-border)] bg-[var(--app-command-muted)] hover:border-[var(--app-border-strong)]"
                                }`}
                            >
                                <AgentAvatar agent={agent} />
                                <div className="min-w-0">
                                    <p className="truncate text-xs font-semibold text-[var(--app-text-strong)]">
                                        {agent.label}
                                    </p>
                                    <p className="mt-1 flex items-center gap-1.5 text-[11px] text-[var(--app-text-muted)]">
                                        <StatusDot status={agent.status} />
                                        {agent.status}
                                    </p>
                                </div>
                            </button>
                        ))}
                        <button className="flex min-w-[120px] items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--app-border)] px-3 py-2 text-xs text-[var(--app-text-muted)] hover:border-[var(--app-border-strong)] hover:text-[var(--app-text-strong)]">
                            <Plus className="h-4 w-4" />
                            Add Agent
                        </button>
                    </div>
                </section>

                <section className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-hidden p-3 xl:grid-cols-[minmax(420px,0.95fr)_minmax(340px,0.65fr)_minmax(360px,0.7fr)_240px]">
                    <section className="flex min-h-[520px] min-w-0 flex-col rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] shadow-[var(--app-elevated-shadow)]">
                        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--app-border)] px-3">
                            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                                {docs.slice(0, 4).map((doc) => (
                                    <button
                                        key={doc.id}
                                        onClick={() => setSelectedDocId(doc.id)}
                                        className={`flex max-w-[180px] shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-xs ${
                                            selectedDoc?.id === doc.id
                                                ? "bg-[var(--app-active-strong)] text-[var(--app-active-foreground)]"
                                                : "bg-[var(--app-command-muted)] text-[var(--app-text-muted)] hover:bg-[var(--app-hover)]"
                                        }`}
                                    >
                                        <FileText className="h-3.5 w-3.5 shrink-0" />
                                        <span className="truncate">{doc.filename}</span>
                                    </button>
                                ))}
                            </div>
                            <Link
                                href={matterDocumentsHref(projectId)}
                                className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--app-border)] text-[var(--app-text-muted)] hover:border-[var(--app-border-strong)] hover:text-[var(--app-text-strong)]"
                                title="Manage documents"
                            >
                                <Plus className="h-4 w-4" />
                            </Link>
                        </div>
                        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--app-border)] px-3 text-[var(--app-text-muted)]">
                            {[Search, RefreshCw, LayoutDashboard].map((Icon, index) => (
                                <button
                                    key={index}
                                    className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                                >
                                    <Icon className="h-4 w-4" />
                                </button>
                            ))}
                            <span className="ml-auto rounded-md border border-[var(--app-border)] px-2 py-1 text-[11px] text-[var(--app-text-muted)]">
                                {selectedDoc ? docTypeLabel(selectedDoc) : "No document"}
                            </span>
                        </div>
                        <div className="min-h-0 flex-1 overflow-hidden bg-white">
                            {selectedDoc ? (
                                <DocPanel
                                    documentId={selectedDoc.id}
                                    filename={selectedDoc.filename}
                                    versionId={null}
                                    versionNumber={selectedDoc.latest_version_number ?? null}
                                    mode={{ kind: "document" }}
                                />
                            ) : (
                                <EmptyPanel
                                    icon={FileText}
                                    title="No matter documents"
                                    body="Upload legal documents in the Documents view to activate the command center."
                                    action={
                                        <Link
                                            href={matterDocumentsHref(projectId)}
                                            className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-500"
                                        >
                                            Open documents
                                        </Link>
                                    }
                                />
                            )}
                        </div>
                    </section>

                    <section className="flex min-h-[520px] min-w-0 flex-col rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)]">
                        <div className="flex h-12 shrink-0 items-center border-b border-[var(--app-border)] px-4">
                            <div className="flex gap-5 text-xs font-medium">
                                <button className="border-b-2 border-blue-400 py-4 text-blue-300">
                                    Chat
                                </button>
                                <button className="py-4 text-[var(--app-text-subtle)]">Thread</button>
                                <button className="py-4 text-[var(--app-text-subtle)]">History</button>
                            </div>
                            <Link
                                href={chats[0] ? `/projects/${projectId}/doc-review/chat/${chats[0].id}` : matterDocReviewHref(projectId)}
                                className="ml-auto rounded-lg border border-[var(--app-border)] px-2.5 py-1.5 text-xs text-[var(--app-text-muted)] hover:border-[var(--app-border-strong)] hover:text-[var(--app-text-strong)]"
                            >
                                Open
                            </Link>
                        </div>
                        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                            {assistantMessages.length > 0 ? (
                                assistantMessages.map((message, index) => (
                                    <AssistantActivity
                                        key={index}
                                        message={message}
                                        citations={message.annotations ?? []}
                                    />
                                ))
                            ) : (
                                <EmptyPanel
                                    icon={MessageSquareText}
                                    title="No assistant analysis yet"
                                    body="Ask Reviewer or Matter Analyst to produce a citation-grounded analysis for this matter."
                                    action={
                                        <button
                                            onClick={() => startAgentTask(AGENT_PROMPTS.reviewer)}
                                            className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-500"
                                        >
                                            Ask Reviewer
                                        </button>
                                    }
                                />
                            )}

                            <div className="rounded-xl border border-amber-400/30 bg-amber-400/8 p-3">
                                <div className="flex items-center gap-2">
                                    <AgentAvatar
                                        agent={{
                                            id: "redliner",
                                            label: "Redliner",
                                            initial: "L",
                                            status: "Pending Approval",
                                            summary: "",
                                            actionLabel: "",
                                        }}
                                    />
                                    <div>
                                        <p className="text-xs font-semibold text-[var(--app-text-strong)]">
                                            Redliner
                                        </p>
                                        <p className="text-[11px] text-amber-300">
                                            {pendingEdits.length > 0
                                                ? "Pending approval"
                                                : "No proposed changes"}
                                        </p>
                                    </div>
                                </div>
                                <div className="mt-3 text-sm text-[var(--app-text)]">
                                    {pendingEdits[0] ? (
                                        <>
                                            <p>Proposed tracked change is ready for review.</p>
                                            <div className="mt-2 flex items-center gap-2 text-xs">
                                                <span className="rounded bg-red-500/15 px-2 py-1 text-red-300 line-through">
                                                    {pendingEdits[0].deleted_text || "Deleted text"}
                                                </span>
                                                <span className="text-[var(--app-text-subtle)]">
                                                    {"->"}
                                                </span>
                                                <span className="rounded bg-emerald-500/15 px-2 py-1 text-emerald-300">
                                                    {pendingEdits[0].inserted_text || "Inserted text"}
                                                </span>
                                            </div>
                                        </>
                                    ) : (
                                        <p>
                                            Ask Redliner to inspect the current document for
                                            market or drafting improvements.
                                        </p>
                                    )}
                                </div>
                                <div className="mt-3 flex gap-2">
                                    <Link
                                        href={chats[0] ? `/projects/${projectId}/doc-review/chat/${chats[0].id}` : matterDocReviewHref(projectId)}
                                        className="rounded-lg border border-amber-300/50 px-3 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-300/10"
                                    >
                                        Review Change
                                    </Link>
                                    <button
                                        onClick={() => startAgentTask(AGENT_PROMPTS.redliner)}
                                        className="rounded-lg border border-[var(--app-border)] px-3 py-1.5 text-xs font-medium text-[var(--app-text-muted)] hover:border-[var(--app-border-strong)] hover:text-[var(--app-text-strong)]"
                                    >
                                        Ask Redliner
                                    </button>
                                </div>
                            </div>

                            <div className="rounded-xl border border-cyan-300/20 bg-cyan-300/6 p-3">
                                <p className="flex items-center gap-2 text-xs font-semibold text-[var(--app-text-strong)]">
                                    <Gauge className="h-4 w-4 text-cyan-300" />
                                    Matter Analyst
                                </p>
                                <p className="mt-2 text-sm leading-5 text-[var(--app-text-muted)]">
                                    Risk: {pendingEdits.length > 0 ? "Medium" : "Unscored"}.
                                    Completion: {completionPct || (docs.length ? 24 : 0)}%.
                                    Ready documents: {readyDocs}.
                                </p>
                                <button
                                    onClick={() => startAgentTask(AGENT_PROMPTS["matter-analyst"])}
                                    className="mt-3 text-xs font-medium text-cyan-300 hover:text-cyan-200"
                                >
                                    Open items <ArrowUpRight className="inline h-3.5 w-3.5" />
                                </button>
                            </div>
                        </div>
                    </section>

                    <section className="flex min-h-[520px] min-w-0 flex-col rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)]">
                        <div className="flex h-12 shrink-0 items-center gap-4 border-b border-[var(--app-border)] px-4">
                            <button className="border-b-2 border-blue-400 py-4 text-xs font-medium text-blue-300">
                                Extraction
                            </button>
                            <button className="py-4 text-xs font-medium text-[var(--app-text-subtle)]">
                                Covenants
                            </button>
                            <button className="py-4 text-xs font-medium text-[var(--app-text-subtle)]">
                                Links ({citations.length})
                            </button>
                            <Link
                                href={selectedReviewId ? `/projects/${projectId}/tabular-reviews/${selectedReviewId}` : matterReviewsHref(projectId)}
                                className="ml-auto rounded-lg border border-[var(--app-border)] px-2.5 py-1.5 text-xs text-[var(--app-text-muted)] hover:border-[var(--app-border-strong)] hover:text-[var(--app-text-strong)]"
                            >
                                Open
                            </Link>
                        </div>
                        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--app-border)] px-3">
                            <select
                                value={selectedReviewId ?? ""}
                                onChange={(event) =>
                                    setSelectedReviewId(event.target.value || null)
                                }
                                className="h-8 min-w-0 flex-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-command-input)] px-2 text-xs text-[var(--app-text)] outline-none focus:border-[var(--app-border-strong)]"
                            >
                                {reviews.length === 0 ? (
                                    <option value="">No reviews yet</option>
                                ) : (
                                    reviews.map((review) => (
                                        <option key={review.id} value={review.id}>
                                            {review.title ?? "Untitled Review"}
                                        </option>
                                    ))
                                )}
                            </select>
                            <button className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--app-text-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]">
                                <RefreshCw className="h-4 w-4" />
                            </button>
                        </div>
                        <div className="min-h-0 flex-1 overflow-auto">
                            {extractionRows.length > 0 ? (
                                <table className="w-full min-w-[520px] border-collapse text-left text-xs">
                                    <thead className="sticky top-0 z-10 bg-[var(--app-panel-strong)] text-[var(--app-text-muted)]">
                                        <tr>
                                            <th className="border-b border-[var(--app-border)] px-3 py-2 font-medium">
                                                Field
                                            </th>
                                            <th className="border-b border-[var(--app-border)] px-3 py-2 font-medium">
                                                Extracted Value
                                            </th>
                                            <th className="border-b border-[var(--app-border)] px-3 py-2 font-medium">
                                                Source
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {extractionRows.map((row) => (
                                            <tr
                                                key={row.field}
                                                className="border-b border-[var(--app-border)] hover:bg-[var(--app-hover)]"
                                            >
                                                <td className="px-3 py-2 font-medium text-[var(--app-text)]">
                                                    {row.field}
                                                </td>
                                                <td className="px-3 py-2 text-[var(--app-text)]">
                                                    {row.value}
                                                </td>
                                                <td className="px-3 py-2">
                                                    <span className="inline-flex items-center gap-1 rounded-md bg-blue-500/10 px-1.5 py-0.5 text-[11px] text-blue-300">
                                                        <ShieldCheck className="h-3 w-3" />
                                                        {row.source}
                                                    </span>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            ) : (
                                <EmptyPanel
                                    icon={Table2}
                                    title="No extraction table yet"
                                    body="Create or open a review table to see structured legal terms in this panel."
                                    action={
                                        <Link
                                            href={matterReviewsHref(projectId)}
                                            className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-500"
                                        >
                                            Open reviews
                                        </Link>
                                    }
                                />
                            )}
                        </div>
                        <div className="flex h-11 shrink-0 items-center justify-between border-t border-[var(--app-border)] px-4 text-xs text-[var(--app-text-muted)]">
                            <button className="flex items-center gap-1.5 text-blue-300 hover:text-blue-200">
                                <Plus className="h-4 w-4" />
                                Add extraction
                            </button>
                            <span>{completionPct}% complete</span>
                        </div>
                    </section>

                    <aside className="hidden min-h-[520px] min-w-0 flex-col gap-3 overflow-y-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-3 xl:flex">
                        <MatterUpcomingEvents matterId={projectId} />
                        <div className="flex items-center justify-between px-1">
                            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--app-text-muted)]">
                                Agents
                            </p>
                            <CircleDot className="h-4 w-4 text-cyan-300" />
                        </div>
                        {agents.map((agent) => (
                            <AgentPanelCard
                                key={agent.id}
                                agent={agent}
                                active={agent.id === selectedAgent}
                                onSelect={() => setSelectedAgent(agent.id)}
                            />
                        ))}
                        <button className="mt-auto flex items-center gap-2 rounded-lg border border-dashed border-[var(--app-border)] px-3 py-2 text-xs text-[var(--app-text-muted)] hover:border-[var(--app-border-strong)] hover:text-[var(--app-text-strong)]">
                            <Plus className="h-4 w-4" />
                            Add Agent
                        </button>
                        <div id="activity" className="scroll-mt-24 pt-2">
                            <div className="mb-2 flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--app-text-muted)]">
                                <ShieldCheck className="h-3.5 w-3.5 text-amber-300" />
                                Chain of Custody
                            </div>
                            <div className="overflow-hidden rounded-xl border border-[var(--app-border)] bg-white">
                                <OperationActivityPanel projectId={projectId} />
                            </div>
                        </div>
                    </aside>
                </section>

                <footer className="shrink-0 border-t border-[var(--app-border)] bg-[var(--app-panel)] p-3">
                    <div className="flex flex-col gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] p-3 md:flex-row md:items-center">
                        <div className="flex items-center gap-2">
                            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--app-text-subtle)]">
                                Command Bar
                            </span>
                            <select
                                value={selectedAgent}
                                onChange={(event) =>
                                    setSelectedAgent(event.target.value as AgentId)
                                }
                                className="h-9 rounded-lg border border-[var(--app-border)] bg-[var(--app-command-input)] px-3 text-xs text-[var(--app-text)] outline-none focus:border-[var(--app-border-strong)]"
                            >
                                {agents.map((agent) => (
                                    <option key={agent.id} value={agent.id}>
                                        {agent.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-command-input)] px-3 focus-within:border-[var(--app-border-strong)]">
                            <button className="text-[var(--app-text-subtle)] hover:text-[var(--app-text-strong)]">
                                <Paperclip className="h-4 w-4" />
                            </button>
                            <input
                                value={command}
                                onChange={(event) => setCommand(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") {
                                        event.preventDefault();
                                        void startAgentTask();
                                    }
                                }}
                                placeholder={`Assign ${selectedAgentModel.label} a task or ask a legal question...`}
                                className="h-11 min-w-0 flex-1 bg-transparent text-sm text-[var(--app-text)] outline-none placeholder:text-[var(--app-text-subtle)]"
                            />
                            <button
                                onClick={() => startAgentTask()}
                                disabled={isPending}
                                className="flex h-9 items-center gap-2 rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-60"
                            >
                                {isPending ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <Send className="h-4 w-4" />
                                )}
                                Send
                            </button>
                        </div>
                    </div>
                </footer>
            </main>
        </div>
    );
}

function Metric({
    label,
    value,
    tone = "slate",
}: {
    label: string;
    value: string;
    tone?: "slate" | "blue" | "green" | "amber";
}) {
    const valueClass =
        tone === "blue"
            ? "text-blue-300"
            : tone === "green"
              ? "text-emerald-300"
              : tone === "amber"
                ? "text-amber-300"
                : "text-[var(--app-text-strong)]";
    return (
        <div className="min-w-0 border-l border-[var(--app-border)] pl-3">
            <p className="text-[11px] text-[var(--app-text-subtle)]">{label}</p>
            <p className={`mt-1 truncate text-sm font-medium ${valueClass}`}>
                {value}
            </p>
        </div>
    );
}

function AssistantActivity({
    message,
    citations,
}: {
    message: CocoLegalMessage;
    citations: CocoLegalCitationAnnotation[];
}) {
    const text = messageText(message);
    return (
        <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] p-3">
            <div className="mb-2 flex items-center gap-2">
                <AgentAvatar
                    agent={{
                        id: "reviewer",
                        label: "Reviewer",
                        initial: "R",
                        status: "Completed",
                        summary: "",
                        actionLabel: "",
                    }}
                />
                <div>
                    <p className="text-xs font-semibold text-[var(--app-text-strong)]">Reviewer</p>
                    <p className="text-[11px] text-emerald-300">Completed</p>
                </div>
            </div>
            <p className="text-sm leading-6 text-[var(--app-text)]">
                {text.length > 520 ? `${text.slice(0, 517)}...` : text}
            </p>
            {citations.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                    {citations.slice(0, 8).map((citation, index) => (
                        <span
                            key={citationChipKey(citation, index)}
                            className="rounded-md bg-blue-500/10 px-1.5 py-0.5 text-[11px] text-blue-300"
                        >
                            {citationChipLabel(citation)}
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}

function AgentPanelCard({
    agent,
    active,
    onSelect,
}: {
    agent: AgentModel;
    active: boolean;
    onSelect: () => void;
}) {
    const border =
        agent.status === "Pending Approval"
            ? "border-amber-400/40"
            : active
              ? "border-cyan-300/40"
              : "border-[var(--app-border)]";
    return (
        <button
            onClick={onSelect}
            className={`w-full rounded-xl border ${border} bg-[var(--app-panel-soft)] p-3 text-left transition hover:border-[var(--app-border-strong)]`}
        >
            <div className="flex items-start gap-3">
                <AgentAvatar agent={agent} />
                <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-semibold text-[var(--app-text-strong)]">
                            {agent.label}
                        </p>
                        {agent.status === "Completed" ? (
                            <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                        ) : agent.status === "Pending Approval" ? (
                            <Clock3 className="h-4 w-4 text-amber-300" />
                        ) : (
                            <Sparkles className="h-4 w-4 text-cyan-300" />
                        )}
                    </div>
                    <p className="mt-1 flex items-center gap-1.5 text-[11px] text-[var(--app-text-muted)]">
                        <StatusDot status={agent.status} />
                        {agent.status}
                    </p>
                </div>
            </div>
            <p className="mt-3 text-xs leading-5 text-[var(--app-text-muted)]">
                {agent.summary}
            </p>
            <Link
                href={agent.href ?? "#"}
                className="mt-3 flex h-8 items-center justify-center rounded-lg border border-[var(--app-border)] text-xs font-medium text-[var(--app-text)] hover:border-[var(--app-border-strong)] hover:text-[var(--app-text-strong)]"
                onClick={(event) => event.stopPropagation()}
            >
                {agent.actionLabel}
            </Link>
        </button>
    );
}
