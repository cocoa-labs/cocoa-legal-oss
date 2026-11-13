"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
    Activity,
    BookOpenCheck,
    FileSignature,
    FileText,
    GitBranch,
    LayoutDashboard,
    MessageSquareText,
    PenLine,
    Table2,
} from "lucide-react";
import {
    activeMatterNavItem,
    matterNavItems,
    type MatterNavItemId,
} from "@/app/lib/matterRoutes";

const ICONS: Record<MatterNavItemId, typeof LayoutDashboard> = {
    "doc-review": MessageSquareText,
    authoring: PenLine,
    history: GitBranch,
    command: LayoutDashboard,
    documents: FileText,
    reviews: Table2,
    signatures: FileSignature,
    workflows: BookOpenCheck,
    activity: Activity,
};

export function MatterNav({
    projectId,
    active,
    variant = "light",
}: {
    projectId: string;
    active?: MatterNavItemId;
    variant?: "light" | "dark";
}) {
    const pathname = usePathname();
    const activeItem = active ?? activeMatterNavItem(pathname, projectId);
    const dark = variant === "dark";

    return (
        <nav
            className={`flex items-center gap-1 overflow-x-auto ${
                dark
                    ? "border-t border-[var(--app-border)] pt-3"
                    : "border-b border-gray-200 px-4 md:px-10"
            }`}
            aria-label="Matter navigation"
        >
            {matterNavItems(projectId).map((item) => {
                const Icon = ICONS[item.id];
                const isActive = item.id === activeItem;
                return (
                    <Link
                        key={item.id}
                        href={item.href}
                        className={`flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-xs font-medium transition ${
                            dark
                                ? isActive
                                    ? "bg-[var(--app-accent-soft)] text-[var(--app-text-strong)] ring-1 ring-[var(--app-border-strong)]"
                                    : "text-[var(--app-text-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                                : isActive
                                  ? "bg-gray-900 text-white"
                                  : "text-gray-500 hover:bg-gray-100 hover:text-gray-900"
                        }`}
                    >
                        <Icon className="h-3.5 w-3.5" />
                        {item.label}
                    </Link>
                );
            })}
        </nav>
    );
}
