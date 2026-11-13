"use client";

import { useMemo, useState } from "react";
import { AlertCircle, Check, Search } from "lucide-react";
import {
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import type { ApiKeyState } from "@/app/lib/cocoLegalApi";
import type { ModelHealthMetadata } from "@/app/lib/cocoLegalApi";
import { isModelAvailable } from "@/app/lib/modelAvailability";
import { useModelsCatalog } from "@/app/hooks/useModelsCatalog";

// Rendering every catalog entry would put hundreds of rows in the menu. The
// search box is the real navigation; this cap just keeps the initial paint
// cheap without pulling in a virtualization dependency.
const MAX_VISIBLE_CATALOG_ROWS = 50;
const SHOW_MODEL_HEALTH =
    process.env.NEXT_PUBLIC_MODEL_HEALTH_INDICATORS_ENABLED !== "false";

const GROUP_ORDER = ["Anthropic", "Google", "OpenAI"];

const HEALTH_LABEL: Record<ModelHealthMetadata["status"], string> = {
    healthy: "Healthy",
    degraded: "Degraded",
    unverified: "Unverified",
    unhealthy: "Unhealthy",
};

const HEALTH_DOT: Record<ModelHealthMetadata["status"], string> = {
    healthy: "bg-emerald-500",
    degraded: "bg-amber-500",
    unverified: "bg-gray-400",
    unhealthy: "bg-red-500",
};

function perMillion(perToken: string): string {
    const n = Number(perToken);
    if (!Number.isFinite(n) || n <= 0) return "";
    const dollars = n * 1e6;
    return dollars < 1
        ? `$${dollars.toFixed(2)}/M`
        : `$${dollars.toFixed(0)}/M`;
}

function contextLabel(tokens: number): string {
    if (!tokens) return "";
    return tokens >= 1_000_000
        ? `${Math.round(tokens / 1_000_000)}M ctx`
        : `${Math.round(tokens / 1000)}K ctx`;
}

interface Props {
    value: string;
    onChange: (id: string) => void;
    apiKeys?: ApiKeyState;
    /** Chat surfaces pass true so only tool-capable models are offered. */
    toolsOnly?: boolean;
}

export function ModelPickerContent({
    value,
    onChange,
    apiKeys,
    toolsOnly = true,
}: Props) {
    const { featured, openrouter, catalogAvailable } =
        useModelsCatalog(toolsOnly);
    const [query, setQuery] = useState("");

    const openrouterConfigured = apiKeys
        ? !!apiKeys.openrouter?.configured
        : true;

    const matches = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return openrouter;
        return openrouter.filter(
            (m) =>
                m.id.toLowerCase().includes(q) ||
                m.name.toLowerCase().includes(q),
        );
    }, [openrouter, query]);

    const visible = matches.slice(0, MAX_VISIBLE_CATALOG_ROWS);

    const selectModel = (id: string, health: ModelHealthMetadata) => {
        if (SHOW_MODEL_HEALTH && health.status !== "healthy") {
            const proceed = window.confirm(
                `${HEALTH_LABEL[health.status]} model: Coco Legal has not recently verified this model for the complete streaming and tool workflow. It remains selectable, but may be less reliable. Continue?`,
            );
            if (!proceed) return;
        }
        onChange(id);
    };

    return (
        <>
            {GROUP_ORDER.map((group, gi) => {
                const items = featured.filter((m) => m.group === group);
                if (items.length === 0) return null;
                return (
                    <div key={group}>
                        {gi > 0 && <DropdownMenuSeparator />}
                        <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-gray-400">
                            {group}
                        </DropdownMenuLabel>
                        {items.map((m) => {
                            const available = apiKeys
                                ? isModelAvailable(m.id, apiKeys)
                                : true;
                            return (
                                <DropdownMenuItem
                                    key={m.id}
                                    className="cursor-pointer"
                                    onSelect={() => selectModel(m.id, m.health)}
                                >
                                    <span
                                        className={`flex-1 ${available ? "" : "text-gray-400"}`}
                                    >
                                        {m.label}
                                    </span>
                                    {SHOW_MODEL_HEALTH && (
                                        <span className="ml-2 flex shrink-0 items-center gap-1 text-[10px] text-gray-400">
                                            <span
                                                className={`h-1.5 w-1.5 rounded-full ${HEALTH_DOT[m.health.status]}`}
                                            />
                                            {HEALTH_LABEL[m.health.status]}
                                        </span>
                                    )}
                                    {!available && (
                                        <AlertCircle
                                            className="h-3.5 w-3.5 text-red-500 ml-1"
                                            aria-label="API key missing"
                                        />
                                    )}
                                    {m.id === value && available && (
                                        <Check className="h-3.5 w-3.5 text-gray-600 ml-1" />
                                    )}
                                </DropdownMenuItem>
                            );
                        })}
                    </div>
                );
            })}

            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-gray-400 flex items-center justify-between">
                <span>OpenRouter</span>
                {!openrouterConfigured && (
                    <AlertCircle
                        className="h-3 w-3 text-red-500"
                        aria-label="API key missing"
                    />
                )}
            </DropdownMenuLabel>

            {!catalogAvailable ? (
                <div className="px-2 py-1.5 text-xs text-gray-400">
                    Catalog unavailable
                </div>
            ) : (
                <>
                    <div className="px-2 pb-1.5">
                        <div className="relative">
                            <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-gray-400" />
                            <input
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                // Radix DropdownMenu implements type-ahead on
                                // keydown and would steal focus from the input.
                                onKeyDown={(e) => e.stopPropagation()}
                                placeholder={`Search ${openrouter.length} models…`}
                                className="w-full rounded-md border border-gray-200 bg-transparent py-1 pl-7 pr-2 text-xs outline-none focus:border-gray-400"
                            />
                        </div>
                    </div>
                    <div className="max-h-64 overflow-y-auto">
                        {visible.length === 0 ? (
                            <div className="px-2 py-1.5 text-xs text-gray-400">
                                No models match “{query}”
                            </div>
                        ) : (
                            visible.map((m) => (
                                <DropdownMenuItem
                                    key={m.id}
                                    className="cursor-pointer flex-col items-start gap-0"
                                    onSelect={() => selectModel(m.id, m.health)}
                                >
                                    <div className="flex w-full items-center">
                                        <span
                                            className={`flex-1 truncate ${openrouterConfigured ? "" : "text-gray-400"}`}
                                        >
                                            {m.name}
                                        </span>
                                        {m.id === value && (
                                            <Check className="h-3.5 w-3.5 text-gray-600 ml-1 shrink-0" />
                                        )}
                                    </div>
                                    <span className="flex w-full items-center gap-2 text-[10px] text-gray-400">
                                        {SHOW_MODEL_HEALTH && (
                                            <span className="flex items-center gap-1">
                                                <span
                                                    className={`h-1.5 w-1.5 rounded-full ${HEALTH_DOT[m.health.status]}`}
                                                />
                                                {HEALTH_LABEL[m.health.status]}
                                            </span>
                                        )}
                                        <span>
                                            {[
                                                contextLabel(m.contextLength),
                                                perMillion(m.pricing.prompt) &&
                                                `${perMillion(m.pricing.prompt)} in`,
                                        ]
                                                .filter(Boolean)
                                                .join(" · ")}
                                        </span>
                                    </span>
                                </DropdownMenuItem>
                            ))
                        )}
                        {matches.length > visible.length && (
                            <div className="px-2 py-1.5 text-[10px] text-gray-400">
                                Showing {visible.length} of {matches.length} —
                                keep typing to narrow
                            </div>
                        )}
                    </div>
                </>
            )}
        </>
    );
}
