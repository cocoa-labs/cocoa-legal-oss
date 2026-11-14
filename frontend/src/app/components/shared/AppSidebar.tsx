"use client";

import { useState, useEffect } from "react";
import {
    PanelLeft,
    MessageSquare,
    FileSearch,
    Mic,
    CalendarDays,
    FolderOpen,
    Table2,
    Library,
    LayoutTemplate,
    Inbox,
    FileSignature,
    Briefcase,
    Zap,
    User,
    Settings,
    ChevronsUpDown,
    ChevronDown,
    Search,
    Code2,
    X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { sourceCodeUrl } from "@/app/lib/deploymentLinks";
import { useAuth } from "@/contexts/AuthContext";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { CocoaLegalIcon } from "@/components/chat/cocoa-legal-icon";
import { SidebarChatItem } from "@/app/components/shared/SidebarChatItem";
import { ThemeToggle } from "@/app/components/shared/ThemeToggle";
import { listChats, listProjects } from "@/app/lib/cocoaLegalApi";
import { useSignatureSummary } from "@/app/components/legal/SignatureSummaryContext";
import type { CocoaLegalChat, CocoaLegalProject } from "@/app/components/shared/types";
import {
    getAccountDisplayName,
    getAccountInitial,
} from "@/lib/userIdentity";
import { matterDefaultHref } from "@/app/lib/matterRoutes";

type NavLeaf = { href: string; label: string; icon: LucideIcon };
type NavGroup = {
    id: string;
    label: string;
    defaultOpen: boolean;
    items: NavLeaf[];
};

// Always visible, ungrouped — the daily entry points.
const TOP_ITEMS: NavLeaf[] = [
    { href: "/assistant", label: "Assistant", icon: MessageSquare },
    { href: "/projects", label: "Matters", icon: FolderOpen },
];

const NAV_GROUPS: NavGroup[] = [
    {
        id: "documents",
        label: "Documents",
        defaultOpen: true,
        items: [
            { href: "/doc-review", label: "Doc Review", icon: FileSearch },
            { href: "/tabular-reviews", label: "Review Tables", icon: Table2 },
            { href: "/templates", label: "Templates", icon: LayoutTemplate },
            { href: "/workflows", label: "Workflows", icon: Library },
        ],
    },
    {
        id: "casework",
        label: "Casework",
        defaultOpen: false,
        items: [
            { href: "/cases", label: "Cases", icon: Briefcase },
            { href: "/signatures", label: "Signatures", icon: FileSignature },
            { href: "/automation", label: "Automation", icon: Zap },
        ],
    },
    {
        id: "workspace",
        label: "Workspace",
        defaultOpen: false,
        items: [
            { href: "/inbox", label: "Inbox", icon: Inbox },
            { href: "/calendar", label: "Calendar", icon: CalendarDays },
            { href: "/recordings", label: "Recordings", icon: Mic },
        ],
    },
];

const SETTINGS_ITEM: NavLeaf = {
    href: "/account",
    label: "Settings",
    icon: Settings,
};

// Collapsed rail renders every capability as a flat icon button.
const RAIL_ITEMS: NavLeaf[] = [
    ...TOP_ITEMS,
    ...NAV_GROUPS.flatMap((g) => g.items),
    SETTINGS_ITEM,
];

const STORAGE_KEYS = {
    groups: "cocoa.sidebar.navGroups.v1",
    recentMatters: "cocoa.sidebar.recentMattersCollapsed.v1",
    assistantHistory: "cocoa.sidebar.assistantHistoryCollapsed.v1",
} as const;

function formatRecentMatterDate(project: CocoaLegalProject) {
    const raw = project.updated_at || project.created_at;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return "No activity";
    return date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
    });
}

interface AppSidebarProps {
    isOpen: boolean;
    onToggle: () => void;
}

export function AppSidebar({ isOpen, onToggle }: AppSidebarProps) {
    const { user } = useAuth();
    const { profile } = useUserProfile();
    const {
        chats,
        currentChatId,
        hasMoreChats,
        loadMoreChats,
        setCurrentChatId,
    } = useChatHistoryContext();
    const { pendingCount: pendingSignatures } = useSignatureSummary();
    const router = useRouter();
    const pathname = usePathname();
    const [shouldAnimate, setShouldAnimate] = useState(false);
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>(() =>
        Object.fromEntries(NAV_GROUPS.map((g) => [g.id, g.defaultOpen])),
    );
    const [recentMattersCollapsed, setRecentMattersCollapsed] = useState(false);
    const [assistantHistoryCollapsed, setAssistantHistoryCollapsed] =
        useState(false);
    const [hydrated, setHydrated] = useState(false);
    const [projectNames, setProjectNames] = useState<Record<string, string>>(
        {},
    );
    const [recentProjects, setRecentProjects] = useState<CocoaLegalProject[] | null>(
        null,
    );
    // Chat-history title search. Deliberately LOCAL view state: the results
    // never enter ChatHistoryContext, so the cached/paginated list underneath
    // is untouched and clearing the box restores it instantly.
    const [chatSearch, setChatSearch] = useState("");
    const [chatSearchResults, setChatSearchResults] = useState<
        CocoaLegalChat[] | null
    >(null);
    const [chatSearchLoading, setChatSearchLoading] = useState(false);

    const trimmedChatSearch = chatSearch.trim();
    const isSearchingChats = trimmedChatSearch.length > 0;

    useEffect(() => {
        if (!user || !trimmedChatSearch) {
            setChatSearchResults(null);
            setChatSearchLoading(false);
            return;
        }
        let cancelled = false;
        setChatSearchLoading(true);
        const timer = setTimeout(() => {
            listChats({ limit: 50, search: trimmedChatSearch })
                .then((results) => {
                    if (cancelled) return;
                    setChatSearchResults(results);
                })
                .catch(() => {
                    if (!cancelled) setChatSearchResults([]);
                })
                .finally(() => {
                    if (!cancelled) setChatSearchLoading(false);
                });
        }, 250);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [trimmedChatSearch, user]);

    // The searched list replaces the context list while a term is active.
    const visibleChats = isSearchingChats ? chatSearchResults : chats;

    useEffect(() => {
        if (!user) return;
        listProjects()
            .then((projects) => {
                const map: Record<string, string> = {};
                for (const p of projects) map[p.id] = p.name;
                setProjectNames(map);
                setRecentProjects(
                    [...projects]
                        .sort(
                            (a, b) =>
                                Date.parse(b.updated_at || b.created_at) -
                                Date.parse(a.updated_at || a.created_at),
                        )
                        .slice(0, 5),
                );
            })
            .catch(() => {
                setProjectNames({});
                setRecentProjects([]);
            });
    }, [user]);

    // Read persisted collapse state AFTER mount (client-only → no SSR mismatch).
    useEffect(() => {
        try {
            const rawGroups = localStorage.getItem(STORAGE_KEYS.groups);
            if (rawGroups) {
                const parsed = JSON.parse(rawGroups) as Record<string, boolean>;
                setGroupOpen((prev) => {
                    const next = { ...prev };
                    for (const g of NAV_GROUPS)
                        if (typeof parsed[g.id] === "boolean")
                            next[g.id] = parsed[g.id];
                    return next;
                });
            }
            const rm = localStorage.getItem(STORAGE_KEYS.recentMatters);
            if (rm !== null) setRecentMattersCollapsed(rm === "true");
            const ah = localStorage.getItem(STORAGE_KEYS.assistantHistory);
            if (ah !== null) setAssistantHistoryCollapsed(ah === "true");
        } catch {
            /* malformed storage — keep defaults */
        } finally {
            setHydrated(true);
        }
    }, []);

    // Persist only after hydration so mount-time defaults never clobber stored values.
    useEffect(() => {
        if (!hydrated) return;
        try {
            localStorage.setItem(
                STORAGE_KEYS.groups,
                JSON.stringify(groupOpen),
            );
        } catch {
            /* ignore */
        }
    }, [groupOpen, hydrated]);

    useEffect(() => {
        if (!hydrated) return;
        try {
            localStorage.setItem(
                STORAGE_KEYS.recentMatters,
                String(recentMattersCollapsed),
            );
            localStorage.setItem(
                STORAGE_KEYS.assistantHistory,
                String(assistantHistoryCollapsed),
            );
        } catch {
            /* ignore */
        }
    }, [recentMattersCollapsed, assistantHistoryCollapsed, hydrated]);

    const toggleGroup = (id: string) =>
        setGroupOpen((prev) => ({ ...prev, [id]: !prev[id] }));

    useEffect(() => {
        const handleClickOutside = () => setIsDropdownOpen(false);
        if (isDropdownOpen) {
            document.addEventListener("click", handleClickOutside);
            return () =>
                document.removeEventListener("click", handleClickOutside);
        }
    }, [isDropdownOpen]);

    useEffect(() => {
        if (pathname.startsWith("/assistant/chat/")) {
            const chatId = pathname.split("/").pop() ?? null;
            setCurrentChatId(chatId);
            return;
        }

        const projectChatMatch = pathname.match(
            /^\/projects\/[^/]+\/(?:doc-review|assistant)\/chat\/([^/]+)/,
        );
        if (projectChatMatch) {
            setCurrentChatId(projectChatMatch[1]);
            return;
        }

        if (
            pathname === "/assistant" ||
            pathname === "/doc-review" ||
            /^\/projects\/[^/]+\/doc-review\/?$/.test(pathname)
        ) {
            setCurrentChatId(null);
        }
    }, [pathname, setCurrentChatId]);

    const getUserInitials = () => getAccountInitial(profile?.displayName);

    const getDisplayName = () => getAccountDisplayName(profile?.displayName);

    const getUserTier = () => {
        if (!profile) return "";
        return profile.tier || "Free";
    };

    if (!user) return null;

    const isNavActive = (href: string, label: string) => {
        if (label === "Doc Review") {
            return (
                pathname === href ||
                pathname.startsWith(`${href}/`) ||
                /^\/projects\/[^/]+\/(?:doc-review|assistant\/chat)(?:\/|$)/.test(
                    pathname,
                )
            );
        }
        if (label === "Matters") {
            return (
                pathname === href ||
                (pathname.startsWith(`${href}/`) &&
                    !/^\/projects\/[^/]+\/(?:doc-review|tabular-reviews)(?:\/|$)/.test(
                        pathname,
                    ))
            );
        }
        if (label === "Review Tables") {
            return (
                pathname === href ||
                pathname.startsWith(`${href}/`) ||
                /^\/projects\/[^/]+\/tabular-reviews(?:\/|$)/.test(pathname)
            );
        }
        return pathname === href || pathname.startsWith(href + "/");
    };

    const isGroupActive = (group: NavGroup) =>
        group.items.some((it) => isNavActive(it.href, it.label));

    // Bubble pending badges from items inside a group (today only Signatures has one).
    const groupPendingCount = (group: NavGroup) =>
        group.items.reduce(
            (sum, it) =>
                sum + (it.label === "Signatures" ? pendingSignatures : 0),
            0,
        );

    const renderNavItem = (item: NavLeaf, iconOnly: boolean) => {
        const { href, label, icon: Icon } = item;
        const isActive = isNavActive(href, label);
        const signatureBadge =
            label === "Signatures" && pendingSignatures > 0
                ? pendingSignatures
                : 0;
        return (
            <button
                key={href}
                onClick={() => router.push(href)}
                title={iconOnly ? label : ""}
                className={`w-full h-9 flex items-center gap-3 px-2.5 py-2 rounded-md transition-colors text-left ${
                    isActive
                        ? "bg-[var(--app-active)] text-[var(--app-text-strong)] shadow-[inset_0_1px_0_var(--app-border)]"
                        : "text-[var(--app-text-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                } ${iconOnly ? "hidden md:flex" : "flex"}`}
            >
                <span className="relative flex-shrink-0">
                    <Icon
                        className={`h-4 w-4 ${
                            isActive
                                ? "text-[var(--app-warm)]"
                                : "text-[var(--app-text-subtle)]"
                        }`}
                    />
                    {/* Collapsed sidebar: a small dot stands in for the count. */}
                    {iconOnly && signatureBadge > 0 && (
                        <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-[var(--app-warm)] ring-2 ring-[var(--app-sidebar)]" />
                    )}
                </span>
                {!iconOnly && (
                    <span
                        className={`flex flex-1 items-center text-sm font-medium ${
                            shouldAnimate ? "sidebar-fade-in-2" : ""
                        }`}
                    >
                        {label}
                        {signatureBadge > 0 && (
                            <span className="ml-auto inline-flex min-w-[18px] items-center justify-center rounded-full bg-[var(--app-warm)] px-1.5 py-0.5 text-[10px] font-semibold leading-none text-[var(--app-active-foreground)]">
                                {signatureBadge}
                            </span>
                        )}
                    </span>
                )}
            </button>
        );
    };

    const renderGroup = (group: NavGroup) => {
        const open = groupOpen[group.id];
        const active = isGroupActive(group);
        const pending = groupPendingCount(group);
        return (
            <div key={group.id} className="mt-1">
                <button
                    onClick={() => toggleGroup(group.id)}
                    className={`sticky top-0 z-10 flex w-full items-center justify-between bg-[var(--app-sidebar)] px-4 py-1.5 text-xs font-semibold transition-colors hover:text-[var(--app-text)] ${
                        active
                            ? "text-[var(--app-text)]"
                            : "text-[var(--app-text-subtle)]"
                    } ${shouldAnimate ? "sidebar-fade-in" : ""}`}
                >
                    <span>{group.label}</span>
                    <span className="flex items-center gap-1.5">
                        {!open && pending > 0 && (
                            <span className="inline-flex min-w-[16px] items-center justify-center rounded-full bg-[var(--app-warm)] px-1 py-0.5 text-[10px] font-semibold leading-none text-[var(--app-active-foreground)]">
                                {pending}
                            </span>
                        )}
                        {!open && active && pending === 0 && (
                            <span className="h-1.5 w-1.5 rounded-full bg-[var(--app-warm)]" />
                        )}
                        <ChevronDown
                            className={`h-3.5 w-3.5 transition-transform ${
                                open ? "" : "-rotate-90"
                            }`}
                        />
                    </span>
                </button>
                {open && (
                    <div className="mt-0.5 space-y-0.5 px-2.5">
                        {group.items.map((it) => renderNavItem(it, false))}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div
            className={`${
                isOpen
                    ? "w-64 h-dvh bg-[var(--app-sidebar)] border-r overflow-hidden"
                    : "w-14 md:h-dvh md:bg-[var(--app-sidebar)] md:border-r h-auto bg-transparent pointer-events-none md:pointer-events-auto overflow-visible"
            } border-[var(--app-border)] text-[var(--app-text)] flex flex-col transition-all duration-300 absolute md:relative z-[99]`}
        >
            {/* Toggle + Logo — pinned */}
            <div
                className={`shrink-0 items-center justify-between px-2.5 py-3 ${
                    !isOpen ? "hidden md:flex" : "flex"
                }`}
            >
                {isOpen && (
                    <div className="px-2.5">
                        <Link
                            href="/assistant"
                            className="flex items-center gap-1.5 hover:opacity-80 transition-opacity"
                        >
                            <CocoaLegalIcon
                                size={22}
                                style={{
                                    filter:
                                        "drop-shadow(0 0 12px rgba(251,191,36,0.16)) brightness(1.55)",
                                }}
                            />
                            <span
                                className={`text-2xl font-light font-serif text-[var(--app-text-strong)] ${
                                    shouldAnimate ? "sidebar-fade-in" : ""
                                }`}
                            >
                                Cocoa Legal
                            </span>
                        </Link>
                    </div>
                )}
                <button
                    onClick={() => {
                        if (isOpen) setShouldAnimate(true);
                        onToggle();
                    }}
                    className="h-9 w-9 p-2.5 items-center flex rounded-md text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                    title={isOpen ? "Close sidebar" : "Open sidebar"}
                >
                    <PanelLeft className="h-4 w-4" />
                </button>
            </div>

            {/* Scroll body — the single scroll owner (nav + both histories). */}
            <div className="sidebar-scroll flex-1 min-h-0 overflow-y-auto py-1">
                {isOpen ? (
                    <>
                        <div className="px-2.5 space-y-0.5">
                            {TOP_ITEMS.map((it) => renderNavItem(it, false))}
                        </div>

                        {NAV_GROUPS.map(renderGroup)}

                        {/* divider: nav ↔ histories */}
                        <div className="mx-4 my-3 border-t border-[var(--app-border)]" />

                        {/* Recent Matters */}
                        <section>
                            <button
                                onClick={() =>
                                    setRecentMattersCollapsed((v) => !v)
                                }
                                className={`sticky top-0 z-10 mb-1 flex w-full items-center justify-between bg-[var(--app-sidebar)] px-4 py-1.5 text-xs font-semibold text-[var(--app-text-subtle)] transition-colors hover:text-[var(--app-text)] ${
                                    shouldAnimate ? "sidebar-fade-in" : ""
                                }`}
                            >
                                <span>Recent Matters</span>
                                <ChevronDown
                                    className={`h-3.5 w-3.5 transition-transform ${
                                        recentMattersCollapsed ? "-rotate-90" : ""
                                    }`}
                                />
                            </button>
                            {!recentMattersCollapsed && (
                                <>
                                    {!recentProjects ? (
                                        <div className="space-y-1 px-2.5">
                                            {[50, 65, 45].map((w, i) => (
                                                <div
                                                    key={i}
                                                    className="h-9 flex items-center px-3 rounded-md"
                                                >
                                                    <div
                                                        className="h-3 bg-[var(--app-active)] rounded animate-pulse"
                                                        style={{
                                                            width: `${w}%`,
                                                        }}
                                                    />
                                                </div>
                                            ))}
                                        </div>
                                    ) : recentProjects.length === 0 ? (
                                        <div
                                            className={`px-5 py-2 text-xs text-[var(--app-text-subtle)] ${
                                                shouldAnimate
                                                    ? "sidebar-fade-in-2"
                                                    : ""
                                            }`}
                                        >
                                            No matters yet
                                        </div>
                                    ) : (
                                        <div
                                            className={`space-y-1.5 px-2.5 ${
                                                shouldAnimate
                                                    ? "sidebar-fade-in-2"
                                                    : ""
                                            }`}
                                        >
                                            {recentProjects.map((project) => {
                                                const isActive =
                                                    pathname ===
                                                        `/projects/${project.id}` ||
                                                    pathname.startsWith(
                                                        `/projects/${project.id}/`,
                                                    );
                                                return (
                                                    <button
                                                        key={project.id}
                                                        onClick={() =>
                                                            router.push(
                                                                matterDefaultHref(
                                                                    project.id,
                                                                ),
                                                            )
                                                        }
                                                        title={project.name}
                                                        className={`flex min-h-12 w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                                                            isActive
                                                                ? "bg-[var(--app-active)] text-[var(--app-text-strong)]"
                                                                : "text-[var(--app-text-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                                                        }`}
                                                    >
                                                        <FolderOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--app-text-subtle)]" />
                                                        <span className="min-w-0 flex-1">
                                                            <span className="block truncate font-medium">
                                                                {project.name}
                                                            </span>
                                                            <span className="mt-1 block truncate text-[11px] text-[var(--app-text-subtle)]">
                                                                {project.document_count ??
                                                                    0}{" "}
                                                                docs ·{" "}
                                                                {project.review_count ??
                                                                    0}{" "}
                                                                reviews ·{" "}
                                                                {formatRecentMatterDate(
                                                                    project,
                                                                )}
                                                            </span>
                                                        </span>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}
                                </>
                            )}
                        </section>

                        {/* divider: matters ↔ history */}
                        <div className="mx-4 my-3 border-t border-[var(--app-border)]" />

                        {/* Assistant History */}
                        <section>
                            <button
                                onClick={() =>
                                    setAssistantHistoryCollapsed((v) => !v)
                                }
                                className={`sticky top-0 z-10 mb-1 flex w-full items-center justify-between bg-[var(--app-sidebar)] px-4 py-1.5 text-xs font-semibold text-[var(--app-text-subtle)] transition-colors hover:text-[var(--app-text)] ${
                                    shouldAnimate ? "sidebar-fade-in" : ""
                                }`}
                            >
                                <span>Assistant History</span>
                                <ChevronDown
                                    className={`h-3.5 w-3.5 transition-transform ${
                                        assistantHistoryCollapsed
                                            ? "-rotate-90"
                                            : ""
                                    }`}
                                />
                            </button>
                            {!assistantHistoryCollapsed && (
                                <div>
                                    <div className="px-2.5 pb-2">
                                        <div className="relative">
                                            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--app-text-subtle)]" />
                                            <input
                                                value={chatSearch}
                                                onChange={(e) =>
                                                    setChatSearch(
                                                        e.target.value,
                                                    )
                                                }
                                                placeholder="Search chat titles"
                                                aria-label="Search chat titles"
                                                className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-panel)] py-1.5 pl-8 pr-7 text-xs text-[var(--app-text-strong)] placeholder:text-[var(--app-text-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
                                            />
                                            {isSearchingChats && (
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        setChatSearch("")
                                                    }
                                                    aria-label="Clear chat search"
                                                    className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-[var(--app-text-subtle)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                                                >
                                                    <X className="h-3 w-3" />
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                    {!visibleChats ? (
                                        <div className="space-y-1 px-2.5">
                                            {[40, 60, 50, 70, 45].map((w, i) => (
                                                <div
                                                    key={i}
                                                    className="h-9 flex items-center px-3 rounded-md"
                                                >
                                                    <div
                                                        className="h-3 bg-[var(--app-active)] rounded animate-pulse"
                                                        style={{
                                                            width: `${w}%`,
                                                        }}
                                                    />
                                                </div>
                                            ))}
                                        </div>
                                    ) : visibleChats.length === 0 ? (
                                        <div
                                            className={`text-xs text-[var(--app-text-subtle)] py-2 px-5 ${
                                                shouldAnimate
                                                    ? "sidebar-fade-in-2"
                                                    : ""
                                            }`}
                                        >
                                            {isSearchingChats
                                                ? chatSearchLoading
                                                    ? "Searching…"
                                                    : "No chats match that title"
                                                : "No chats yet"}
                                        </div>
                                    ) : (
                                        <>
                                            <div
                                                className={`space-y-1 px-2.5 ${
                                                    shouldAnimate
                                                        ? "sidebar-fade-in-2"
                                                        : ""
                                                }`}
                                            >
                                                {visibleChats.map((chat) => (
                                                    <SidebarChatItem
                                                        key={chat.id}
                                                        chat={chat}
                                                        isActive={
                                                            currentChatId ===
                                                            chat.id
                                                        }
                                                        projectName={
                                                            chat.project_id
                                                                ? projectNames[
                                                                      chat
                                                                          .project_id
                                                                  ]
                                                                : undefined
                                                        }
                                                        onSelect={() => {
                                                            setCurrentChatId(
                                                                chat.id,
                                                            );
                                                            router.push(
                                                                chat.project_id
                                                                    ? `/projects/${chat.project_id}/doc-review/chat/${chat.id}`
                                                                    : `/assistant/chat/${chat.id}`,
                                                            );
                                                        }}
                                                    />
                                                ))}
                                            </div>
                                            {/* "Load more" paginates the
                                                UNSEARCHED list, so hide it
                                                while a search is active. */}
                                            {!isSearchingChats && hasMoreChats && (
                                                <div className="px-2.5 pt-1">
                                                    <button
                                                        onClick={loadMoreChats}
                                                        className="flex h-8 w-full items-center justify-start rounded-md px-3 text-left text-xs font-medium text-[var(--app-text-subtle)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text)]"
                                                    >
                                                        Load more
                                                    </button>
                                                </div>
                                            )}
                                        </>
                                    )}
                                </div>
                            )}
                        </section>
                    </>
                ) : (
                    // Collapsed rail — all capabilities as flat icon buttons.
                    <div className="hidden md:block px-2.5 space-y-0.5">
                        {RAIL_ITEMS.map((it) => renderNavItem(it, true))}
                    </div>
                )}
            </div>

            {/* Footer — pinned */}
            <div className="shrink-0 border-t border-[var(--app-border)]">
                {/* Utility row: theme toggle + Settings */}
                <div
                    className={`flex items-center gap-2 px-2.5 py-2 ${
                        !isOpen ? "hidden md:flex md:justify-center" : ""
                    }`}
                >
                    <ThemeToggle
                        compact={!isOpen}
                        className={isOpen ? "w-auto flex-1" : ""}
                    />
                    {isOpen && (
                        <button
                            onClick={() => router.push("/account")}
                            title="Settings"
                            aria-label="Settings"
                            className={`flex h-9 w-9 items-center justify-center rounded-md border border-[var(--app-border)] bg-[var(--app-command-muted)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)] ${
                                pathname.startsWith("/account")
                                    ? "text-[var(--app-warm)]"
                                    : "text-[var(--app-text-muted)]"
                            }`}
                        >
                            <Settings className="h-4 w-4" />
                        </button>
                    )}
                </div>

                {/* User Profile */}
                {user && (
                    <div className="relative">
                        <button
                            onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                            className={`flex items-center transition-colors w-full px-3.5 py-4 border-t border-[var(--app-border)] ${
                                !isOpen ? "hidden md:flex" : ""
                            } ${
                                pathname === "/account" || isDropdownOpen
                                    ? "bg-[var(--app-active)]"
                                    : "hover:bg-[var(--app-hover)]"
                            }`}
                            title={!isOpen ? user.email : undefined}
                        >
                            <div className="h-7 w-7 flex-shrink-0 rounded-full bg-[var(--app-panel-strong)] ring-1 ring-[var(--app-border)] flex items-center justify-center text-[var(--app-text-strong)] text-sm font-medium font-serif">
                                {getUserInitials()}
                            </div>
                            {isOpen && (
                                <div
                                    className={`text-left flex-1 min-w-0 pl-3 flex items-center justify-between gap-2 ${
                                        shouldAnimate ? "sidebar-fade-in-2" : ""
                                    }`}
                                >
                                    <div className="flex flex-col gap-0.5 min-w-0">
                                        <div className="text-sm font-medium text-[var(--app-text-strong)] leading-none">
                                            {getDisplayName()}
                                        </div>
                                        <div className="text-[12px] text-[var(--app-text-subtle)] leading-none">
                                            {getUserTier()}
                                        </div>
                                    </div>
                                    <ChevronsUpDown className="h-4 w-4 flex-shrink-0 text-[var(--app-text-subtle)]" />
                                </div>
                            )}
                        </button>

                        {isDropdownOpen && (
                            <div className="absolute bottom-full left-0 m-1 bg-[var(--app-panel)] rounded-lg shadow-lg border border-[var(--app-border)] p-1 z-50 w-62 whitespace-nowrap">
                                <button
                                    onClick={() => {
                                        router.push("/account");
                                        setIsDropdownOpen(false);
                                    }}
                                    className="w-full px-4 py-2 text-left text-sm text-[var(--app-text-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)] flex items-center gap-2 rounded-md"
                                >
                                    <User className="h-4 w-4" />
                                    Settings
                                </button>
                                <a
                                    href={sourceCodeUrl()}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={() => setIsDropdownOpen(false)}
                                    className="w-full px-4 py-2 text-left text-sm text-[var(--app-text-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)] flex items-center gap-2 rounded-md"
                                >
                                    <Code2 className="h-4 w-4" />
                                    Source code
                                </a>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
