export const APP_VERSION_PROTOCOL = "cocoa-app-version-v1";
export const APP_VERSION_ENDPOINT = "/api/app-version";
export const APP_VERSION_RELOAD_KEY = "cocoa-app-version:reload-target";
const COMPOSER_DRAFT_PREFIX = "cocoa-composer-draft:v1:";

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function composerDraftStorageKey(pathname: string) {
    return `${COMPOSER_DRAFT_PREFIX}${pathname}`;
}

export function readComposerDraft(storage: DraftStorage, key: string) {
    try {
        return storage.getItem(key) ?? "";
    } catch {
        return "";
    }
}

export function persistComposerDraft(
    storage: DraftStorage,
    key: string,
    value: string,
) {
    try {
        if (value) storage.setItem(key, value);
        else storage.removeItem(key);
    } catch {
        // Storage can be unavailable in hardened browsing modes.
    }
}

export type AppVersionBlockers = {
    drafts: number;
    busy: number;
};

export type AppVersionAction = "current" | "reload" | "defer" | "intervention";

export function decideAppVersionAction(params: {
    currentBuildId: string;
    remoteBuildId: string | null;
    lastReloadTarget: string | null;
    blockers: AppVersionBlockers;
}): AppVersionAction {
    const remote = params.remoteBuildId?.trim();
    if (!remote || remote === params.currentBuildId) return "current";
    if (params.lastReloadTarget === remote) return "intervention";
    if (params.blockers.busy > 0 || params.blockers.drafts > 0) return "defer";
    return "reload";
}
