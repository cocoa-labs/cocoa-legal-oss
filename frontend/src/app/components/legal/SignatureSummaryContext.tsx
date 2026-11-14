"use client";

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState,
} from "react";
import { useAuth } from "@/contexts/AuthContext";
import {
    listSignatures,
    type SignatureEnvelopeSummary,
} from "@/app/lib/cocoaLegalApi";
import { groupEnvelopes } from "./SignaturesPanel";

/** How many of the newest envelopes to expose for compact "recent" displays. */
const RECENT_LIMIT = 4;
/** Poll cadence for the shared global signature summary. */
const POLL_INTERVAL_MS = 30000;

interface SignatureSummaryValue {
    /** Count of non-terminal envelopes awaiting action (sent/partial/approval). */
    pendingCount: number;
    /** Count of fully-executed envelopes. */
    completedCount: number;
    /** A few newest envelopes (any status) for compact previews. */
    recent: SignatureEnvelopeSummary[];
    /** True until the first fetch resolves. */
    loading: boolean;
    /** Force an immediate refetch (e.g. after creating/cancelling a request). */
    refetch: () => void;
}

const SignatureSummaryContext = createContext<SignatureSummaryValue>({
    pendingCount: 0,
    completedCount: 0,
    recent: [],
    loading: true,
    refetch: () => {},
});

/**
 * Fetches the signed-in user's signature envelopes once (then polls), and
 * exposes pending/completed counts plus a few recent envelopes so the sidebar
 * badge and the Matters summary card can share a single request. Mount once in
 * the authed app shell. Counts are derived with `groupEnvelopes` so they stay
 * consistent with the Signatures hub grouping.
 */
export function SignatureSummaryProvider({
    children,
}: {
    children: React.ReactNode;
}) {
    const { isAuthenticated } = useAuth();
    const [envelopes, setEnvelopes] = useState<SignatureEnvelopeSummary[]>([]);
    const [loading, setLoading] = useState(true);
    // Bump to trigger an out-of-band refetch.
    const [refetchTick, setRefetchTick] = useState(0);
    const cancelledRef = useRef(false);

    const refetch = useCallback(() => setRefetchTick((t) => t + 1), []);

    useEffect(() => {
        if (!isAuthenticated) {
            setEnvelopes([]);
            setLoading(false);
            return;
        }

        cancelledRef.current = false;
        let timer: ReturnType<typeof setInterval> | null = null;

        const load = async () => {
            try {
                const res = await listSignatures();
                if (!cancelledRef.current) setEnvelopes(res.envelopes);
            } catch {
                // Keep the last good snapshot on transient failures.
            } finally {
                if (!cancelledRef.current) setLoading(false);
            }
        };

        void load();
        timer = setInterval(() => void load(), POLL_INTERVAL_MS);

        return () => {
            cancelledRef.current = true;
            if (timer !== null) clearInterval(timer);
        };
    }, [isAuthenticated, refetchTick]);

    const grouped = groupEnvelopes(envelopes);
    // Newest-first across all statuses (sent_at, falling back to created_at).
    const recent = [...envelopes]
        .sort((a, b) => {
            const at = Date.parse(a.envelope.sent_at ?? a.envelope.created_at);
            const bt = Date.parse(b.envelope.sent_at ?? b.envelope.created_at);
            return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
        })
        .slice(0, RECENT_LIMIT);
    const value: SignatureSummaryValue = {
        pendingCount: grouped.pending.length,
        completedCount: grouped.completed.length,
        recent,
        loading,
        refetch,
    };

    return (
        <SignatureSummaryContext.Provider value={value}>
            {children}
        </SignatureSummaryContext.Provider>
    );
}

/** Read the shared signature summary (counts + recent envelopes). */
export function useSignatureSummary(): SignatureSummaryValue {
    return useContext(SignatureSummaryContext);
}
