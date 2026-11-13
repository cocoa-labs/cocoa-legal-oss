"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/contexts/ThemeContext";
import { cn } from "@/lib/utils";

export function ThemeToggle({
    compact = false,
    className,
}: {
    compact?: boolean;
    className?: string;
}) {
    const { theme, toggleTheme } = useTheme();
    const isDark = theme === "dark";
    const label = isDark ? "Switch to light mode" : "Switch to dark mode";
    const Icon = isDark ? Sun : Moon;

    return (
        <button
            type="button"
            onClick={toggleTheme}
            aria-label={label}
            title={label}
            className={cn(
                "flex h-9 items-center rounded-md border border-[var(--app-border)] bg-[var(--app-command-muted)] text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]",
                compact
                    ? "w-9 justify-center"
                    : "w-full justify-between gap-3 px-2.5 text-left text-sm font-medium",
                className,
            )}
        >
            {!compact && (
                <span>{isDark ? "Light mode" : "Dark mode"}</span>
            )}
            <Icon className="h-4 w-4 shrink-0" />
        </button>
    );
}
