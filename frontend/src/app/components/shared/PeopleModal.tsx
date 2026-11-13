"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { X, User, UserPlus, Loader2, Plus } from "lucide-react";
import type {
    ProjectMember,
    ProjectMemberRole,
    ProjectPeople,
} from "@/app/lib/cocoLegalApi";

export interface SharedResource {
    id: string;
    shared_with?: string[] | null;
}

interface Props {
    open: boolean;
    onClose: () => void;
    resource: SharedResource | null;
    fetchPeople: (id: string) => Promise<ProjectPeople>;
    currentUserEmail?: string | null;
    breadcrumb: string[];
    /** Legacy standalone-review sharing, retained until reviews are scoped. */
    onSharedWithChange?: (sharedWith: string[]) => Promise<void> | void;
    onInvite?: (
        email: string,
        role: Exclude<ProjectMemberRole, "owner">,
    ) => Promise<void>;
    onRoleChange?: (
        membershipId: string,
        role: Exclude<ProjectMemberRole, "owner">,
    ) => Promise<void>;
    onRemove?: (membershipId: string) => Promise<void>;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ASSIGNABLE_ROLES = [
    "admin",
    "lawyer",
    "editor",
    "reviewer",
    "viewer",
] as const;

type RosterRow = Omit<ProjectMember, "email" | "role"> & {
    email: string;
    role: ProjectMemberRole | "member";
};

export function PeopleModal({
    open,
    onClose,
    resource,
    fetchPeople,
    currentUserEmail,
    breadcrumb,
    onSharedWithChange,
    onInvite,
    onRoleChange,
    onRemove,
}: Props) {
    const [newEmail, setNewEmail] = useState("");
    const [newRole, setNewRole] =
        useState<Exclude<ProjectMemberRole, "owner">>("editor");
    const [busyKey, setBusyKey] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [people, setPeople] = useState<ProjectPeople | null>(null);
    const [peopleLoading, setPeopleLoading] = useState(false);
    const [refreshVersion, setRefreshVersion] = useState(0);

    const resourceId = resource?.id ?? null;
    const sharedWith = useMemo(
        () =>
            Array.isArray(resource?.shared_with)
                ? resource.shared_with
                : [],
        [resource?.shared_with],
    );
    const sharedKey = useMemo(
        () => sharedWith.map((email) => email.toLowerCase()).sort().join(","),
        [sharedWith],
    );

    useEffect(() => {
        if (!open) return;
        setNewEmail("");
        setNewRole("editor");
        setError(null);
        setBusyKey(null);
    }, [open]);

    useEffect(() => {
        if (!open || !resourceId) return;
        let cancelled = false;
        setPeopleLoading(true);
        void fetchPeople(resourceId)
            .then((data) => {
                if (!cancelled) setPeople(data);
            })
            .catch((reason: unknown) => {
                if (!cancelled) {
                    setError(
                        reason instanceof Error
                            ? reason.message
                            : "Could not load project members.",
                    );
                }
            })
            .finally(() => {
                if (!cancelled) setPeopleLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [fetchPeople, open, refreshVersion, resourceId, sharedKey]);

    const roster = useMemo<RosterRow[]>(() => {
        const roleAware = (people?.members ?? []).filter(
            (member) => member.role && member.email,
        );
        if (roleAware.length) {
            return roleAware.map((member) => ({
                ...member,
                email: member.email!,
                role: member.role!,
            }));
        }

        // Compatibility shape returned by standalone tabular reviews.
        const rows: RosterRow[] = [];
        if (people?.owner?.email) {
            rows.push({
                user_id: people.owner.user_id,
                email: people.owner.email,
                display_name: people.owner.display_name,
                role: "owner",
            });
        }
        const displayByEmail = new Map(
            (people?.members ?? []).flatMap((member) =>
                member.email
                    ? [[member.email.toLowerCase(), member.display_name] as const]
                    : [],
            ),
        );
        for (const email of sharedWith) {
            if (
                people?.owner?.email &&
                email.toLowerCase() === people.owner.email.toLowerCase()
            )
                continue;
            rows.push({
                email,
                display_name: displayByEmail.get(email.toLowerCase()) ?? null,
                role: "member",
            });
        }
        return rows;
    }, [people, sharedWith]);

    if (!open || !resource) return null;

    const trimmedNewEmail = newEmail.trim().toLowerCase();
    const currentEmail = currentUserEmail?.trim().toLowerCase() ?? null;
    const existingEmails = new Set(roster.map((entry) => entry.email.toLowerCase()));
    const isValidEmail = EMAIL_RE.test(trimmedNewEmail);
    const alreadyShared = existingEmails.has(trimmedNewEmail);
    const isSelfEmail = currentEmail === trimmedNewEmail;
    const canManage = people?.can_manage ?? Boolean(onSharedWithChange);
    const canAdd =
        canManage &&
        isValidEmail &&
        !alreadyShared &&
        !isSelfEmail &&
        busyKey === null;

    async function handleAdd() {
        if (!canAdd) return;
        setBusyKey("add");
        setError(null);
        try {
            if (onInvite) {
                await onInvite(trimmedNewEmail, newRole);
            } else if (onSharedWithChange) {
                await onSharedWithChange([...sharedWith, trimmedNewEmail]);
            } else {
                return;
            }
            setNewEmail("");
            setRefreshVersion((value) => value + 1);
        } catch (reason) {
            setError(
                reason instanceof Error
                    ? reason.message
                    : "Could not add the member.",
            );
        } finally {
            setBusyKey(null);
        }
    }

    async function handleRoleChange(
        entry: RosterRow,
        role: Exclude<ProjectMemberRole, "owner">,
    ) {
        if (!entry.id || !onRoleChange) return;
        setBusyKey(entry.id);
        setError(null);
        try {
            await onRoleChange(entry.id, role);
            setRefreshVersion((value) => value + 1);
        } catch (reason) {
            setError(
                reason instanceof Error
                    ? reason.message
                    : "Could not change the member role.",
            );
        } finally {
            setBusyKey(null);
        }
    }

    async function handleRemove(entry: RosterRow) {
        setBusyKey(entry.id ?? entry.email);
        setError(null);
        try {
            if (entry.id && onRemove) {
                await onRemove(entry.id);
            } else if (onSharedWithChange) {
                await onSharedWithChange(
                    sharedWith.filter(
                        (email) =>
                            email.toLowerCase() !== entry.email.toLowerCase(),
                    ),
                );
            } else {
                return;
            }
            setRefreshVersion((value) => value + 1);
        } catch (reason) {
            setError(
                reason instanceof Error
                    ? reason.message
                    : "Could not remove the member.",
            );
        } finally {
            setBusyKey(null);
        }
    }

    return createPortal(
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/10 backdrop-blur-xs">
            <div className="flex h-[600px] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-2xl">
                <div className="flex items-center justify-between px-5 py-4">
                    <div className="flex items-center gap-1.5 text-xs text-gray-400">
                        {breadcrumb.map((segment, index) => (
                            <span key={segment} className="flex items-center gap-1.5">
                                {index > 0 ? <span>›</span> : null}
                                {segment}
                            </span>
                        ))}
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close people dialog"
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {canManage ? (
                    <div className="px-4 pb-2 pt-1">
                        <div className="flex items-center gap-2">
                            <label className="flex flex-1 items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                                <UserPlus className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                                <span className="sr-only">Member email</span>
                                <input
                                    type="email"
                                    placeholder="Add by email…"
                                    value={newEmail}
                                    onChange={(event) => setNewEmail(event.target.value)}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter") void handleAdd();
                                    }}
                                    className="flex-1 bg-transparent text-sm text-gray-700 outline-none placeholder:text-gray-400"
                                    autoFocus
                                />
                            </label>
                            {onInvite ? (
                                <select
                                    aria-label="New member role"
                                    value={newRole}
                                    onChange={(event) =>
                                        setNewRole(
                                            event.target.value as Exclude<
                                                ProjectMemberRole,
                                                "owner"
                                            >,
                                        )
                                    }
                                    className="rounded-lg border border-gray-200 bg-white px-2 py-2 text-xs text-gray-700"
                                >
                                    {ASSIGNABLE_ROLES.map((role) => (
                                        <option key={role} value={role}>
                                            {role}
                                        </option>
                                    ))}
                                </select>
                            ) : null}
                            <button
                                type="button"
                                onClick={() => void handleAdd()}
                                disabled={!canAdd}
                                aria-label="Add member"
                                className="inline-flex items-center justify-center rounded-lg border border-gray-900 bg-gray-900 p-2 text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {busyKey === "add" ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    <Plus className="h-3.5 w-3.5" />
                                )}
                            </button>
                        </div>
                        {alreadyShared && trimmedNewEmail ? (
                            <p className="mt-1.5 text-xs text-gray-400">
                                This address already has access.
                            </p>
                        ) : null}
                        {isSelfEmail && trimmedNewEmail ? (
                            <p className="mt-1.5 text-xs text-gray-400">
                                You cannot invite yourself.
                            </p>
                        ) : null}
                        {trimmedNewEmail && !isValidEmail ? (
                            <p className="mt-1.5 text-xs text-gray-400">
                                Enter a valid email.
                            </p>
                        ) : null}
                    </div>
                ) : null}

                {error ? (
                    <p className="mx-4 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
                        {error}
                    </p>
                ) : null}

                <div className="flex items-center gap-2 px-4 pb-1 pt-3">
                    <h3 className="text-xs font-medium text-gray-500">
                        People with access
                    </h3>
                    {peopleLoading ? (
                        <Loader2 className="h-3 w-3 animate-spin text-gray-400" />
                    ) : null}
                </div>

                <div className="flex-1 overflow-y-auto px-4 pb-2">
                    {roster.length === 0 ? (
                        <div className="flex h-full items-center justify-center text-sm text-gray-400">
                            No one has access yet.
                        </div>
                    ) : (
                        <ul className="divide-y divide-gray-100">
                            {roster.map((entry) => {
                                const isYou =
                                    entry.is_current_user ||
                                    currentEmail === entry.email.toLowerCase();
                                const primary =
                                    entry.display_name?.trim() || entry.email;
                                const canEditEntry =
                                    canManage &&
                                    entry.role !== "owner" &&
                                    !isYou;
                                return (
                                    <li
                                        key={entry.id ?? `${entry.role}-${entry.email}`}
                                        className="flex items-center gap-3 py-3"
                                    >
                                        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-900 text-white">
                                            <User className="h-3 w-3" />
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-sm text-gray-800">
                                                {primary}
                                                {isYou ? (
                                                    <span className="ml-1.5 text-xs text-gray-400">
                                                        (You)
                                                    </span>
                                                ) : null}
                                            </p>
                                            <p className="truncate text-xs text-gray-400">
                                                {entry.display_name ? `${entry.email} · ` : ""}
                                                {entry.status === "invited"
                                                    ? "invited"
                                                    : entry.role}
                                            </p>
                                        </div>
                                        {canEditEntry && entry.id && onRoleChange ? (
                                            <select
                                                aria-label={`Role for ${entry.email}`}
                                                value={entry.role}
                                                disabled={busyKey !== null}
                                                onChange={(event) =>
                                                    void handleRoleChange(
                                                        entry,
                                                        event.target.value as Exclude<
                                                            ProjectMemberRole,
                                                            "owner"
                                                        >,
                                                    )
                                                }
                                                className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-600"
                                            >
                                                {ASSIGNABLE_ROLES.map((role) => (
                                                    <option key={role} value={role}>
                                                        {role}
                                                    </option>
                                                ))}
                                            </select>
                                        ) : null}
                                        {canEditEntry && (onRemove || onSharedWithChange) ? (
                                            <button
                                                type="button"
                                                onClick={() => void handleRemove(entry)}
                                                disabled={busyKey !== null}
                                                className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                                            >
                                                {busyKey === (entry.id ?? entry.email) ? (
                                                    <Loader2 className="h-3 w-3 animate-spin" />
                                                ) : null}
                                                Remove
                                            </button>
                                        ) : null}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>

                <div className="px-5 py-3 text-[11px] text-gray-400">
                    {roster.length} {roster.length === 1 ? "person" : "people"} with access.
                </div>
            </div>
        </div>,
        document.body,
    );
}
