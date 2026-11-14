"use client";

import { useState } from "react";
import { AlertCircle, Check, ChevronDown, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUserProfile } from "@/contexts/UserProfileContext";
import type { ApiKeyState } from "@/app/lib/cocoaLegalApi";
import { MODELS } from "@/app/components/assistant/ModelToggle";
import { ModelPickerContent } from "@/app/components/assistant/ModelPickerContent";
import { isModelAvailable } from "@/app/lib/modelAvailability";

const API_KEY_FIELDS = [
    {
        provider: "claude",
        label: "Anthropic (Claude) API Key",
        placeholder: "sk-ant-…",
    },
    {
        provider: "gemini",
        label: "Google (Gemini) API Key",
        placeholder: "AI…",
    },
    {
        provider: "openai",
        label: "OpenAI API Key",
        placeholder: "sk-…",
    },
    {
        provider: "openrouter",
        label: "OpenRouter API Key",
        placeholder: "sk-or-…",
    },
] as const;

export default function ModelsAndApiKeysPage() {
    const { profile, updateModelPreference, updateApiKey } = useUserProfile();

    return (
        <div className="space-y-4 text-[var(--app-text)]">
            {/* Model Preferences */}
            <div className="pb-6">
                <div className="flex items-center gap-2 mb-4">
                    <h2 className="text-2xl font-medium font-serif text-[var(--app-text-strong)]">
                        Model Preferences
                    </h2>
                </div>
                <div className="space-y-4 max-w-md">
                    <div>
                        <label className="text-sm text-[var(--app-text-muted)] block mb-2">
                            Review table model
                        </label>
                        <p className="text-xs text-[var(--app-text-subtle)] mb-2">
                            We recommend using a smaller model for review
                            tables to reduce token costs.
                        </p>
                        <TabularModelDropdown
                            value={
                                profile?.tabularModel ?? "claude-sonnet-5"
                            }
                            apiKeys={profile?.apiKeys}
                            onChange={(id) =>
                                updateModelPreference("tabularModel", id)
                            }
                        />
                    </div>
                </div>
            </div>

            {/* API Keys */}
            <div className="py-6">
                <div className="flex items-center gap-2 mb-2">
                    <h2 className="text-2xl font-medium font-serif text-[var(--app-text-strong)]">
                        API Keys
                    </h2>
                </div>
                <p className="text-sm text-[var(--app-text-muted)] mb-4 max-w-xl">
                    You must provide your own API keys for the app to work or
                    add your API keys into the .env file if you are running your
                    own instance of Cocoa Legal.
                </p>
                <p className="text-xs text-[var(--app-text-subtle)] mb-4 max-w-xl">
                    Title generation automatically routes to the cheapest
                    configured provider model.
                </p>
                <p className="text-xs text-[var(--app-text-subtle)] mb-4 max-w-xl">
                    Enterprise legal search uses server-managed Tavily, Exa,
                    and Firecrawl keys from the backend environment.
                </p>
                <div className="space-y-4 max-w-xl">
                    {API_KEY_FIELDS.map((field) => (
                        <ApiKeyField
                            key={`${field.provider}:${!!profile?.apiKeys[field.provider].configured}:${profile?.apiKeys[field.provider].source ?? "user"}`}
                            label={field.label}
                            placeholder={field.placeholder}
                            hasSavedKey={
                                !!profile?.apiKeys[field.provider].configured
                            }
                            isServerConfigured={
                                profile?.apiKeys[field.provider].source ===
                                "env"
                            }
                            onSave={(value) =>
                                updateApiKey(
                                    field.provider,
                                    value.trim() || null,
                                )
                            }
                            onRemove={() =>
                                updateApiKey(field.provider, null)
                            }
                        />
                    ))}
                </div>
            </div>
        </div>
    );
}

function TabularModelDropdown({
    value,
    onChange,
    apiKeys,
}: {
    value: string;
    onChange: (id: string) => void;
    apiKeys?: ApiKeyState;
}) {
    const [isOpen, setIsOpen] = useState(false);
    const selected = MODELS.find((m) => m.id === value);
    const selectedAvailable = apiKeys ? isModelAvailable(value, apiKeys) : true;

    return (
        <DropdownMenu onOpenChange={setIsOpen}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className="w-full h-9 rounded-md border border-[var(--app-border)] bg-[var(--app-command-input)] px-3 text-sm shadow-sm flex items-center justify-between gap-2 hover:bg-[var(--app-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--app-accent-soft)]"
                >
                    <span className="flex items-center gap-2 min-w-0">
                        {!selectedAvailable && (
                            <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
                        )}
                        <span className="truncate text-[var(--app-text-strong)]">
                            {selected?.label ??
                                (value.includes("/")
                                    ? value
                                    : "Select a model")}
                        </span>
                    </span>
                    <ChevronDown
                        className={`h-3.5 w-3.5 shrink-0 text-[var(--app-text-muted)] transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                    />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                className="z-50"
                style={{ width: "var(--radix-dropdown-menu-trigger-width)" }}
                align="start"
            >
                {/* Same picker as the chat surfaces. Tabular review runs a
                    bounded extraction prompt with no tool calls, so the
                    catalog is not filtered to tool-capable models here. */}
                <ModelPickerContent
                    value={value}
                    onChange={onChange}
                    apiKeys={apiKeys}
                    toolsOnly={false}
                />
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function ApiKeyField({
    label,
    placeholder,
    hasSavedKey,
    isServerConfigured,
    onSave,
    onRemove,
}: {
    label: string;
    placeholder: string;
    hasSavedKey: boolean;
    isServerConfigured: boolean;
    onSave: (value: string) => Promise<boolean>;
    onRemove: () => Promise<boolean>;
}) {
    const [value, setValue] = useState("");
    const [reveal, setReveal] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    const dirty = value.trim().length > 0;

    const handleSave = async () => {
        setIsSaving(true);
        const ok = await onSave(value);
        setIsSaving(false);
        if (ok) {
            setValue("");
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
        } else {
            alert(`Failed to save ${label}.`);
        }
    };

    const handleRemove = async () => {
        setIsSaving(true);
        const ok = await onRemove();
        setIsSaving(false);
        if (!ok) alert(`Failed to remove ${label}.`);
    };

    return (
        <div>
            <label className="text-sm text-[var(--app-text-muted)] block mb-2">{label}</label>
            {isServerConfigured && (
                <div className="mb-2 rounded-md border border-blue-100 bg-blue-50 px-3 py-2">
                    <p className="text-xs text-blue-800">
                        A server .env key is configured for this provider.
                        Browser API-key edits are disabled.
                    </p>
                    {hasSavedKey && (
                        <p className="mt-1 text-xs text-blue-800">
                            The server key will be used for this provider.
                        </p>
                    )}
                </div>
            )}
            {hasSavedKey && !isServerConfigured && (
                <p className="text-xs text-[var(--app-text-muted)] mb-2">
                    A key is saved. Paste a new key to replace it.
                </p>
            )}
            <div className="flex gap-2">
                <div className="relative flex-1">
                    <Input
                        type={reveal ? "text" : "password"}
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        placeholder={
                            isServerConfigured
                                ? "Server .env key configured"
                                : hasSavedKey
                                  ? "Saved key hidden"
                                  : placeholder
                        }
                        className="pr-10 bg-[var(--app-command-input)]"
                        autoComplete="off"
                        spellCheck={false}
                        disabled={isServerConfigured}
                    />
                    <button
                        type="button"
                        onClick={() => setReveal((r) => !r)}
                        disabled={isServerConfigured}
                        className="absolute inset-y-0 right-2 flex items-center text-[var(--app-text-subtle)] hover:text-[var(--app-text)] disabled:cursor-not-allowed disabled:opacity-40"
                        aria-label={reveal ? "Hide key" : "Show key"}
                    >
                        {reveal ? (
                            <EyeOff className="h-4 w-4" />
                        ) : (
                            <Eye className="h-4 w-4" />
                        )}
                    </button>
                </div>
                <Button
                    onClick={handleSave}
                    disabled={isServerConfigured || isSaving || !dirty || saved}
                    className="min-w-[80px] transition-all bg-[var(--app-active-strong)] text-[var(--app-active-foreground)] hover:opacity-90"
                >
                    {isSaving ? (
                        "Saving..."
                    ) : saved ? (
                        <>
                            <Check className="h-4 w-3" />
                            Saved
                        </>
                    ) : (
                        "Save"
                    )}
                </Button>
                {hasSavedKey && !isServerConfigured && (
                    <Button
                        type="button"
                        variant="outline"
                        onClick={handleRemove}
                        disabled={isSaving}
                    >
                        Remove
                    </Button>
                )}
            </div>
        </div>
    );
}
