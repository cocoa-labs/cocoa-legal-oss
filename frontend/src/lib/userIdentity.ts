export const MAX_DISPLAY_NAME_LENGTH = 80;

export function normalizeDisplayName(
    displayName: string | null | undefined,
): string | null {
    const trimmed = displayName?.trim();
    return trimmed ? trimmed : null;
}

export function getGreetingName(
    displayName: string | null | undefined,
): string {
    return normalizeDisplayName(displayName) ?? "there";
}

export function getAccountDisplayName(
    displayName: string | null | undefined,
): string {
    return normalizeDisplayName(displayName) ?? "Account";
}

export function getAccountInitial(
    displayName: string | null | undefined,
): string {
    return getAccountDisplayName(displayName).charAt(0).toUpperCase();
}
