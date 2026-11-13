"use client";

import { useCallback, useState } from "react";
import { ALLOWED_MODEL_IDS, DEFAULT_MODEL_ID } from "../components/assistant/ModelToggle";

// A stored id is valid if it is a natively registered model or an OpenRouter
// slug. The catalog is fetched asynchronously and is not consulted here — the
// backend's resolveModel is the real gate, and discarding a legitimate catalog
// selection on load would be worse than passing an unknown id through.
function isSelectableModelId(id: string): boolean {
    return ALLOWED_MODEL_IDS.has(id) || id.includes("/");
}

const STORAGE_KEY = "cocoLegal.selectedModel";
const LEGACY_STORAGE_KEY = "mike.selectedModel";

function readStored(): string {
    if (typeof window === "undefined") return DEFAULT_MODEL_ID;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw && isSelectableModelId(raw)) return raw;
    const legacyRaw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacyRaw && isSelectableModelId(legacyRaw)) {
        window.localStorage.setItem(STORAGE_KEY, legacyRaw);
        window.localStorage.removeItem(LEGACY_STORAGE_KEY);
        return legacyRaw;
    }
    return DEFAULT_MODEL_ID;
}

export function useSelectedModel(): [string, (id: string) => void] {
    const [model, setModelState] = useState<string>(() => readStored());

    const setModel = useCallback((id: string) => {
        const next = isSelectableModelId(id) ? id : DEFAULT_MODEL_ID;
        setModelState(next);
        if (typeof window !== "undefined") {
            window.localStorage.setItem(STORAGE_KEY, next);
        }
    }, []);

    return [model, setModel];
}
