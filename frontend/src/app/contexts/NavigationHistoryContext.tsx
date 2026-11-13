"use client";

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { getBackFallbackHref } from "@/app/lib/backNavigation";

const MAX_HISTORY_LENGTH = 40;

interface NavigationHistoryContextValue {
    canGoBack: boolean;
    goBack: () => void;
}

const NavigationHistoryContext = createContext<NavigationHistoryContextValue>({
    canGoBack: false,
    goBack: () => {},
});

function stripQuery(href: string) {
    return href.split("?")[0] || "/";
}

export function NavigationHistoryProvider({
    children,
}: {
    children: React.ReactNode;
}) {
    const router = useRouter();
    const pathname = usePathname();
    const currentHref = pathname;
    const pendingBackHrefRef = useRef<string | null>(null);
    const [history, setHistory] = useState<string[]>([]);

    useEffect(() => {
        setHistory((prev) => {
            const pendingBackHref = pendingBackHrefRef.current;
            if (pendingBackHref === currentHref) {
                pendingBackHrefRef.current = null;
                return prev.at(-1) === currentHref ? prev : [...prev, currentHref];
            }

            if (prev.at(-1) === currentHref) return prev;

            const next = [...prev, currentHref];
            return next.slice(-MAX_HISTORY_LENGTH);
        });
    }, [currentHref]);

    const previousHref = useMemo(() => {
        if (history.at(-1) !== currentHref) return history.at(-1) ?? null;
        return history.at(-2) ?? null;
    }, [currentHref, history]);

    const fallbackHref = getBackFallbackHref(pathname);
    const canGoBack = Boolean(previousHref || fallbackHref);

    const goBack = useCallback(() => {
        const destination = previousHref ?? fallbackHref;
        if (!destination) return;

        if (previousHref) {
            pendingBackHrefRef.current = destination;
            setHistory((prev) => prev.slice(0, -1));
        } else {
            pendingBackHrefRef.current = destination;
            setHistory([destination]);
        }

        if (stripQuery(destination) === stripQuery(currentHref)) {
            router.replace(destination);
        } else {
            router.push(destination);
        }
    }, [currentHref, fallbackHref, previousHref, router]);

    const value = useMemo(
        () => ({
            canGoBack,
            goBack,
        }),
        [canGoBack, goBack],
    );

    return (
        <NavigationHistoryContext.Provider value={value}>
            {children}
        </NavigationHistoryContext.Provider>
    );
}

export function useNavigationHistory() {
    return useContext(NavigationHistoryContext);
}
