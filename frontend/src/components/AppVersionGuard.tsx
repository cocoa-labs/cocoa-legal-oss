"use client";

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useId,
    useRef,
    useState,
} from "react";

import {
    APP_VERSION_ENDPOINT,
    APP_VERSION_PROTOCOL,
    APP_VERSION_RELOAD_KEY,
    decideAppVersionAction,
    type AppVersionBlockers,
} from "@/app/lib/appVersionState";

type BlockerKind = "draft" | "busy";
type ReloadSafetyContextValue = (
    id: string,
    kind: BlockerKind,
    blocked: boolean,
) => void;

const ReloadSafetyContext = createContext<ReloadSafetyContextValue | null>(
    null,
);
const CURRENT_BUILD_ID =
    process.env.NEXT_PUBLIC_COCO_BUILD_ID?.trim() || "development";

export function useAppVersionReloadBlocker(
    blocked: boolean,
    kind: BlockerKind = "busy",
) {
    const context = useContext(ReloadSafetyContext);
    const id = useId();
    useEffect(() => {
        context?.(id, kind, blocked);
        return () => context?.(id, kind, false);
    }, [blocked, context, id, kind]);
}

export function AppVersionGuard({ children }: { children: React.ReactNode }) {
    const blockerMapRef = useRef(new Map<string, BlockerKind>());
    const reloadStartedRef = useRef(false);
    const requestInFlightRef = useRef(false);
    const [blockers, setBlockers] = useState<AppVersionBlockers>({
        drafts: 0,
        busy: 0,
    });
    const [pendingBuildId, setPendingBuildId] = useState<string | null>(null);
    const [needsIntervention, setNeedsIntervention] = useState(false);

    const setBlocker = useCallback(
        (id: string, kind: BlockerKind, blocked: boolean) => {
            if (blocked) blockerMapRef.current.set(id, kind);
            else blockerMapRef.current.delete(id);
            let drafts = 0;
            let busy = 0;
            for (const value of blockerMapRef.current.values()) {
                if (value === "draft") drafts += 1;
                else busy += 1;
            }
            setBlockers((current) =>
                current.drafts === drafts && current.busy === busy
                    ? current
                    : { drafts, busy },
            );
        },
        [],
    );

    const reloadForBuild = useCallback((buildId: string) => {
        if (reloadStartedRef.current) return;
        reloadStartedRef.current = true;
        try {
            sessionStorage.setItem(APP_VERSION_RELOAD_KEY, buildId);
        } catch {
            // A reload still updates the app when session storage is blocked.
        }
        window.location.reload();
    }, []);

    const checkVersion = useCallback(async () => {
        if (requestInFlightRef.current || reloadStartedRef.current) return;
        requestInFlightRef.current = true;
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 8_000);
        try {
            const response = await fetch(
                `${APP_VERSION_ENDPOINT}?build=${encodeURIComponent(CURRENT_BUILD_ID)}&at=${Date.now()}`,
                {
                    cache: "no-store",
                    credentials: "same-origin",
                    signal: controller.signal,
                },
            );
            if (!response.ok) return;
            const payload = (await response.json()) as {
                protocol?: unknown;
                build_id?: unknown;
            };
            if (
                payload.protocol !== APP_VERSION_PROTOCOL ||
                typeof payload.build_id !== "string"
            ) {
                return;
            }
            let lastReloadTarget: string | null = null;
            try {
                lastReloadTarget = sessionStorage.getItem(
                    APP_VERSION_RELOAD_KEY,
                );
            } catch {
                // Continue without loop metadata when storage is blocked.
            }
            const currentBlockers = {
                drafts: [...blockerMapRef.current.values()].filter(
                    (kind) => kind === "draft",
                ).length,
                busy: [...blockerMapRef.current.values()].filter(
                    (kind) => kind === "busy",
                ).length,
            };
            const action = decideAppVersionAction({
                currentBuildId: CURRENT_BUILD_ID,
                remoteBuildId: payload.build_id,
                lastReloadTarget,
                blockers: currentBlockers,
            });
            if (action === "current") {
                if (lastReloadTarget === CURRENT_BUILD_ID) {
                    try {
                        sessionStorage.removeItem(APP_VERSION_RELOAD_KEY);
                    } catch {
                        // Nothing else is required once this build is current.
                    }
                }
                setPendingBuildId(null);
                setNeedsIntervention(false);
            } else if (action === "reload") {
                reloadForBuild(payload.build_id);
            } else {
                setPendingBuildId(payload.build_id);
                setNeedsIntervention(action === "intervention");
            }
        } catch {
            // Offline and failed checks leave the current application running.
        } finally {
            window.clearTimeout(timeout);
            requestInFlightRef.current = false;
        }
    }, [reloadForBuild]);

    useEffect(() => {
        void checkVersion();
        const interval = window.setInterval(() => void checkVersion(), 60_000);
        const onFocus = () => void checkVersion();
        const onVisibility = () => {
            if (document.visibilityState === "visible") void checkVersion();
        };
        window.addEventListener("focus", onFocus);
        document.addEventListener("visibilitychange", onVisibility);
        return () => {
            window.clearInterval(interval);
            window.removeEventListener("focus", onFocus);
            document.removeEventListener("visibilitychange", onVisibility);
        };
    }, [checkVersion]);

    useEffect(() => {
        if (
            pendingBuildId &&
            !needsIntervention &&
            blockers.drafts === 0 &&
            blockers.busy === 0
        ) {
            reloadForBuild(pendingBuildId);
        }
    }, [blockers, needsIntervention, pendingBuildId, reloadForBuild]);

    return (
        <ReloadSafetyContext.Provider value={setBlocker}>
            {children}
            {pendingBuildId ? (
                <div
                    role="status"
                    aria-live="polite"
                    className="fixed inset-x-0 top-0 z-[1000] flex items-center justify-center gap-3 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-950 shadow-sm"
                    data-app-version-update
                >
                    <span>
                        {needsIntervention
                            ? "An app update needs a manual refresh to finish loading."
                            : blockers.busy > 0
                              ? "An app update is ready and will load after the current response or upload finishes."
                              : "An app update is ready. Your unsent text has been saved."}
                    </span>
                    <button
                        type="button"
                        disabled={blockers.busy > 0}
                        onClick={() => reloadForBuild(pendingBuildId)}
                        className="rounded-md bg-amber-950 px-3 py-1.5 font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {blockers.drafts > 0
                            ? "Reload and restore draft"
                            : "Reload update"}
                    </button>
                </div>
            ) : null}
        </ReloadSafetyContext.Provider>
    );
}
