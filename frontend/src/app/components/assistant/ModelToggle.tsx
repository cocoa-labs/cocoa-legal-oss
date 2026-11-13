"use client";

import { useState } from "react";
import { ChevronDown, AlertCircle } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isModelAvailable } from "@/app/lib/modelAvailability";
import type { ApiKeyState } from "@/app/lib/cocoLegalApi";
import { useModelsCatalog } from "@/app/hooks/useModelsCatalog";
import { cn } from "@/lib/utils";
import { ModelPickerContent } from "./ModelPickerContent";

const SHOW_MODEL_HEALTH =
    process.env.NEXT_PUBLIC_MODEL_HEALTH_INDICATORS_ENABLED !== "false";

export interface ModelOption {
    id: string;
    label: string;
    group: "Anthropic" | "Google" | "OpenAI";
}

// Superseded ids stay listed so a previously stored selection still resolves.
// Mirrors the backend registry in backend/src/lib/llm/models.ts — keep both in
// sync when adding a model.
export const MODELS: ModelOption[] = [
    { id: "claude-fable-5", label: "Claude Fable 5", group: "Anthropic" },
    { id: "claude-opus-5", label: "Claude Opus 5", group: "Anthropic" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5", group: "Anthropic" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8", group: "Anthropic" },
    { id: "claude-opus-4-7", label: "Claude Opus 4.7", group: "Anthropic" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", group: "Anthropic" },
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", group: "Google" },
    { id: "gemini-3-flash-preview", label: "Gemini 3 Flash", group: "Google" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", group: "OpenAI" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", group: "OpenAI" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", group: "OpenAI" },
    { id: "gpt-5.5", label: "GPT-5.5", group: "OpenAI" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", group: "OpenAI" },
];

export const DEFAULT_MODEL_ID = "claude-sonnet-5";

export const ALLOWED_MODEL_IDS = new Set(MODELS.map((m) => m.id));

interface Props {
    value: string;
    onChange: (id: string) => void;
    apiKeys?: ApiKeyState;
    variant?: "default" | "command";
}

export function ModelToggle({
    value,
    onChange,
    apiKeys,
    variant = "default",
}: Props) {
    const [isOpen, setIsOpen] = useState(false);
    const isCommand = variant === "command";
    const { featured, openrouter } = useModelsCatalog();
    const selected = MODELS.find((m) => m.id === value);
    // An OpenRouter selection is named by the catalog. Before that loads, the
    // slug's model half is a reasonable stand-in for "anthropic/claude-x".
    const selectedLabel =
        selected?.label ??
        (value.includes("/")
            ? (openrouter.find((m) => m.id === value)?.name ??
              value.split("/").pop() ??
              "Model")
            : "Model");
    const selectedAvailable = apiKeys ? isModelAvailable(value, apiKeys) : true;
    const selectedHealth =
        featured.find((m) => m.id === value)?.health ??
        openrouter.find((m) => m.id === value)?.health;
    const selectedHealthWarning =
        SHOW_MODEL_HEALTH &&
        selectedHealth &&
        selectedHealth.status !== "healthy";

    return (
        <DropdownMenu onOpenChange={setIsOpen}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className={cn(
                        "flex items-center gap-1.5 rounded-lg px-2 h-8 text-sm transition-colors cursor-pointer",
                        isCommand
                            ? "text-[var(--app-text-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                            : "text-gray-400 hover:bg-gray-100 hover:text-gray-700",
                        isOpen &&
                            (isCommand
                                ? "bg-[var(--app-active)] text-[var(--app-text-strong)]"
                                : "bg-gray-100 text-gray-700"),
                    )}
                    title={
                        !selectedAvailable
                            ? "API key missing for selected model"
                            : selectedHealthWarning
                              ? `${selectedHealth.status[0].toUpperCase()}${selectedHealth.status.slice(1)} model health`
                              : "Choose model"
                    }
                >
                    {!selectedAvailable && (
                        <AlertCircle className="h-3 w-3 shrink-0 text-red-500" />
                    )}
                    {selectedAvailable && selectedHealthWarning && (
                        <AlertCircle className="h-3 w-3 shrink-0 text-amber-500" />
                    )}
                    <span className="max-w-[140px] truncate">
                        {selectedLabel}
                    </span>
                    <ChevronDown
                        className={`h-3 w-3 shrink-0 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                    />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-72 z-50" side="top" align="start">
                <ModelPickerContent
                    value={value}
                    onChange={onChange}
                    apiKeys={apiKeys}
                />
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
