export type MatterNavItemId =
    | "doc-review"
    | "authoring"
    | "history"
    | "command"
    | "documents"
    | "reviews"
    | "signatures"
    | "workflows"
    | "activity";

export function matterDocReviewHref(projectId: string, docId?: string) {
    const base = `/projects/${projectId}/doc-review`;
    return docId ? `${base}?doc=${encodeURIComponent(docId)}` : base;
}

export function matterAuthoringHref(projectId: string) {
    return `/projects/${projectId}/authoring`;
}

export function matterDocHistoryHref(projectId: string) {
    return `/projects/${projectId}/doc-review/history`;
}

export function matterCommandHref(projectId: string) {
    return `/projects/${projectId}/workspace`;
}

export function matterDocumentsHref(projectId: string) {
    return `/projects/${projectId}`;
}

export function matterAssistantHref(projectId: string) {
    return `/projects/${projectId}/assistant`;
}

export function matterReviewsHref(projectId: string) {
    return `/projects/${projectId}/tabular-reviews`;
}

export function matterSignaturesHref(projectId: string) {
    return `/projects/${projectId}/signatures`;
}

export function matterWorkflowsHref() {
    return "/workflows";
}

export function matterActivityHref(projectId: string) {
    return `${matterCommandHref(projectId)}#activity`;
}

export function matterDefaultHref(projectId: string) {
    return matterDocReviewHref(projectId);
}

export function matterNavItems(projectId: string) {
    return [
        {
            id: "doc-review" as const,
            label: "Doc Review",
            href: matterDocReviewHref(projectId),
        },
        {
            id: "authoring" as const,
            label: "Draft",
            href: matterAuthoringHref(projectId),
        },
        {
            id: "history" as const,
            label: "History",
            href: matterDocHistoryHref(projectId),
        },
        {
            id: "documents" as const,
            label: "Documents",
            href: matterDocumentsHref(projectId),
        },
        {
            id: "reviews" as const,
            label: "Review Tables",
            href: matterReviewsHref(projectId),
        },
        {
            id: "signatures" as const,
            label: "Signatures",
            href: matterSignaturesHref(projectId),
        },
        {
            id: "command" as const,
            label: "Command",
            href: matterCommandHref(projectId),
        },
        {
            id: "workflows" as const,
            label: "Playbooks",
            href: matterWorkflowsHref(),
        },
        {
            id: "activity" as const,
            label: "Activity",
            href: matterActivityHref(projectId),
        },
    ];
}

export function activeMatterNavItem(
    pathname: string,
    projectId: string,
): MatterNavItemId {
    if (pathname.startsWith(`/projects/${projectId}/doc-review/history`)) {
        return "history";
    }
    if (pathname.startsWith(`/projects/${projectId}/authoring`)) {
        return "authoring";
    }
    if (
        pathname.startsWith(`/projects/${projectId}/doc-review`) ||
        pathname.startsWith(`/projects/${projectId}/assistant`)
    ) {
        return "doc-review";
    }
    if (pathname.startsWith(`/projects/${projectId}/tabular-reviews`)) {
        return "reviews";
    }
    if (pathname.startsWith(`/projects/${projectId}/signatures`)) {
        return "signatures";
    }
    if (pathname.startsWith(`/projects/${projectId}/workspace`)) {
        return "command";
    }
    if (pathname.startsWith("/workflows")) {
        return "workflows";
    }
    return "documents";
}
