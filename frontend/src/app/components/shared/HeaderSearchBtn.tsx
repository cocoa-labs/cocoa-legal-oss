"use client";

import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";

interface Props {
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    variant?: "light" | "dark";
}

export function HeaderSearchBtn({
    value,
    onChange,
    placeholder = "Search…",
    variant = "light",
}: Props) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const dark = variant === "dark";

    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                setOpen(false);
                onChange("");
            }
        }
        if (open) document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [open, onChange]);

    return (
        <div ref={ref} className="relative flex items-center">
            {open ? (
                <div
                    className={`absolute right-0 top-1/2 z-10 flex w-72 -translate-y-1/2 items-center gap-2 rounded-lg border px-3 py-1.5 shadow-sm ${
                        dark
                            ? "border-[var(--app-border)] bg-[var(--app-panel)]"
                            : "border-gray-200 bg-white"
                    }`}
                >
                    <Search
                        className={`h-3.5 w-3.5 shrink-0 ${
                            dark ? "text-[var(--app-text-subtle)]" : "text-gray-400"
                        }`}
                    />
                    <input
                        autoFocus
                        type="text"
                        placeholder={placeholder}
                        value={value}
                        onChange={(e) => onChange(e.target.value)}
                        className={`flex-1 bg-transparent text-sm outline-none ${
                            dark
                                ? "text-[var(--app-text-strong)] placeholder:text-[var(--app-text-subtle)]"
                                : "text-gray-700 placeholder:text-gray-400"
                        }`}
                    />
                    <button
                        onClick={() => { setOpen(false); onChange(""); }}
                        className={
                            dark
                                ? "text-[var(--app-text-subtle)] hover:text-[var(--app-text-strong)]"
                                : "text-gray-400 hover:text-gray-600"
                        }
                    >
                        <X className="h-3.5 w-3.5" />
                    </button>
                </div>
            ) : (
                <button
                    onClick={() => setOpen(true)}
                    className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
                        dark
                            ? "text-[var(--app-text-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                            : "text-gray-500 hover:text-gray-900"
                    }`}
                >
                    <Search className="h-4 w-4" />
                </button>
            )}
        </div>
    );
}
