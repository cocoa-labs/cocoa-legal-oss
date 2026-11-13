"use client";

import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNavigationHistory } from "@/app/contexts/NavigationHistoryContext";

interface AppBackButtonProps {
    variant?: "dark" | "light";
    className?: string;
}

export function AppBackButton({
    variant = "light",
    className,
}: AppBackButtonProps) {
    const { canGoBack, goBack } = useNavigationHistory();

    if (!canGoBack) return null;

    const dark = variant === "dark";

    return (
        <button
            type="button"
            aria-label="Back"
            title="Back"
            onClick={goBack}
            className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
                dark
                    ? "text-[var(--app-text-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)] focus-visible:ring-[var(--app-accent)] focus-visible:ring-offset-[var(--app-shell)]"
                    : "text-gray-500 hover:bg-gray-100 hover:text-gray-900 focus-visible:ring-gray-400 focus-visible:ring-offset-white",
                className,
            )}
        >
            <ArrowLeft className="h-4 w-4" />
        </button>
    );
}
