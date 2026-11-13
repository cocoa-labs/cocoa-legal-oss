import React from "react";

interface Tab<T extends string> {
    id: T;
    label: string;
}

interface Props<T extends string> {
    tabs: Tab<T>[];
    active: T;
    onChange: (id: T) => void;
    variant?: "light" | "dark";
    /** Optional content rendered on the right side of the toolbar */
    actions?: React.ReactNode;
}

export function ToolbarTabs<T extends string>({
    tabs,
    active,
    onChange,
    variant = "light",
    actions,
}: Props<T>) {
    const dark = variant === "dark";
    return (
        <div
            className={`flex h-10 items-center border-b px-4 md:px-10 ${
                dark
                    ? "border-[var(--app-border)] bg-[var(--app-shell-subtle)]"
                    : "border-gray-200 bg-white"
            }`}
        >
            <div className="flex-1 flex items-center gap-5">
                {tabs.map((tab) => (
                    <button
                        key={tab.id}
                        onClick={() => onChange(tab.id)}
                        className={`text-xs transition-colors ${
                            active === tab.id
                                ? dark
                                    ? "font-medium text-[var(--app-text-strong)]"
                                    : "font-medium text-gray-700"
                                : dark
                                  ? "font-normal text-[var(--app-text-subtle)] hover:text-[var(--app-text)]"
                                  : "font-normal text-gray-500 hover:text-gray-700"
                        }`}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>
            {actions && (
                <div className="flex items-center gap-2">{actions}</div>
            )}
        </div>
    );
}
