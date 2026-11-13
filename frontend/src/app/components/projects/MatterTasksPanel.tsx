"use client";

import { useEffect, useState } from "react";
import { Check, Loader2, Plus, RotateCcw, X } from "lucide-react";
import {
    ACTION_STATE_MUTATED_EVENT,
    cancelProjectTask,
    createProjectTask,
    getProjectActionState,
    reopenProjectTask,
    updateProjectTask,
    type MatterTask,
    type ProjectMemberRole,
} from "@/app/lib/cocoLegalApi";

export function MatterTasksPanel({
    projectId,
    currentRole,
}: {
    projectId: string;
    currentRole?: ProjectMemberRole;
}) {
    const [tasks, setTasks] = useState<MatterTask[]>([]);
    const [newTitle, setNewTitle] = useState("");
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const canManage =
        currentRole === "owner" ||
        currentRole === "admin" ||
        currentRole === "lawyer" ||
        currentRole === "editor";
    const canCompleteManual = canManage || currentRole === "reviewer";

    useEffect(() => {
        let cancelled = false;
        let cursor: string | null = null;
        const load = async () => {
            try {
                const state = await getProjectActionState(projectId, cursor);
                if (cancelled || state.unchanged) return;
                cursor = state.cursor;
                setTasks(state.tasks);
                setError(null);
            } catch (reason) {
                if (!cancelled)
                    setError(
                        reason instanceof Error
                            ? reason.message
                            : "Could not load matter tasks.",
                    );
            }
        };
        void load();
        const handleMutation = () => void load();
        window.addEventListener(ACTION_STATE_MUTATED_EVENT, handleMutation);
        const timer = setInterval(() => void load(), 15_000);
        return () => {
            cancelled = true;
            clearInterval(timer);
            window.removeEventListener(
                ACTION_STATE_MUTATED_EVENT,
                handleMutation,
            );
        };
    }, [projectId]);

    async function mutate(key: string, action: () => Promise<unknown>) {
        setBusy(key);
        setError(null);
        try {
            await action();
        } catch (reason) {
            setError(
                reason instanceof Error ? reason.message : "Task update failed.",
            );
        } finally {
            setBusy(null);
        }
    }

    const open = tasks.filter((task) => task.status === "open");
    const recentlyCompleted = tasks
        .filter((task) => task.status === "completed")
        .slice(0, 3);

    return (
        <section className="mx-5 mt-3 rounded-xl border border-gray-200 bg-white px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                    <h2 className="text-sm font-medium text-gray-900">Matter tasks</h2>
                    <p className="text-xs text-gray-500">
                        {open.length} open · completion follows exact linked evidence
                    </p>
                </div>
                {canManage ? (
                    <form
                        className="flex min-w-64 items-center gap-2"
                        onSubmit={(event) => {
                            event.preventDefault();
                            const title = newTitle.trim();
                            if (!title) return;
                            void mutate("create", async () => {
                                await createProjectTask(projectId, {
                                    title,
                                    completion_rule: { type: "manual" },
                                });
                                setNewTitle("");
                            });
                        }}
                    >
                        <input
                            value={newTitle}
                            onChange={(event) => setNewTitle(event.target.value)}
                            placeholder="Add a manual task"
                            className="min-w-0 flex-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs outline-none focus:border-gray-400"
                        />
                        <button
                            type="submit"
                            disabled={!newTitle.trim() || busy !== null}
                            className="rounded-lg bg-gray-900 p-1.5 text-white disabled:opacity-40"
                            aria-label="Add matter task"
                        >
                            {busy === "create" ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <Plus className="h-3.5 w-3.5" />
                            )}
                        </button>
                    </form>
                ) : null}
            </div>
            {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
            {open.length ? (
                <ul className="mt-2 divide-y divide-gray-100">
                    {open.slice(0, 8).map((task) => (
                        <li key={task.id} className="flex items-center gap-2 py-2 text-xs">
                            <button
                                type="button"
                                disabled={
                                    busy !== null ||
                                    !canCompleteManual ||
                                    task.completion_rule.type !== "manual"
                                }
                                onClick={() =>
                                    void mutate(task.id, () =>
                                        updateProjectTask(projectId, task.id, {
                                            expected_revision: task.revision,
                                            status: "completed",
                                        }),
                                    )
                                }
                                title={
                                    task.completion_rule.type === "manual"
                                        ? canCompleteManual
                                            ? "Complete assigned task"
                                            : "Read-only task"
                                        : `Completes automatically from ${task.completion_rule.type}`
                                }
                                className="rounded border border-gray-300 p-0.5 text-gray-500 disabled:bg-gray-100 disabled:text-gray-300"
                            >
                                {busy === task.id ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                    <Check className="h-3 w-3" />
                                )}
                            </button>
                            <span className="min-w-0 flex-1 truncate text-gray-700">
                                {task.title}
                            </span>
                            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">
                                {task.completion_rule.type.replaceAll("_", " ")}
                            </span>
                            {canManage ? (
                                <button
                                    type="button"
                                    disabled={busy !== null}
                                    onClick={() =>
                                        void mutate(task.id, () =>
                                            cancelProjectTask(
                                                projectId,
                                                task.id,
                                                task.revision,
                                            ),
                                        )
                                    }
                                    className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                                    aria-label={`Cancel ${task.title}`}
                                >
                                    <X className="h-3 w-3" />
                                </button>
                            ) : null}
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="mt-2 text-xs text-gray-400">No open tasks.</p>
            )}
            {canManage && recentlyCompleted.length ? (
                <details className="mt-2 text-xs text-gray-500">
                    <summary className="cursor-pointer">Recently completed</summary>
                    <ul className="mt-1 space-y-1">
                        {recentlyCompleted.map((task) => (
                            <li key={task.id} className="flex items-center gap-2">
                                <span className="min-w-0 flex-1 truncate line-through">
                                    {task.title}
                                </span>
                                <button
                                    type="button"
                                    disabled={busy !== null}
                                    onClick={() =>
                                        void mutate(task.id, () =>
                                            reopenProjectTask(
                                                projectId,
                                                task.id,
                                                task.revision,
                                            ),
                                        )
                                    }
                                    className="inline-flex items-center gap-1 rounded px-1.5 py-1 hover:bg-gray-100"
                                >
                                    <RotateCcw className="h-3 w-3" /> Reopen
                                </button>
                            </li>
                        ))}
                    </ul>
                </details>
            ) : null}
        </section>
    );
}
