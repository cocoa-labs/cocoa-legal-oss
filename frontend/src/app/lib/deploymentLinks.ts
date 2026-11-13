// Links that belong to whoever deploys this app. Each reads its NEXT_PUBLIC_*
// variable literally so Next.js inlines it at build time; empty or whitespace
// values count as unset. Legal links are hidden when unset; the source link
// defaults to the public repository (AGPL-3.0 section 13).

const DEFAULT_SOURCE_CODE_URL = "https://github.com/cocoa-labs/cocoa-legal-oss";
const DEFAULT_SITE_URL = "http://localhost:3003";

function configured(value: string | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}

export function termsUrl(): string | null {
    return configured(process.env.NEXT_PUBLIC_TERMS_URL);
}

export function privacyUrl(): string | null {
    return configured(process.env.NEXT_PUBLIC_PRIVACY_URL);
}

export function sourceCodeUrl(): string {
    return configured(process.env.NEXT_PUBLIC_SOURCE_CODE_URL) ?? DEFAULT_SOURCE_CODE_URL;
}

export function siteUrl(): string {
    return configured(process.env.NEXT_PUBLIC_SITE_URL) ?? DEFAULT_SITE_URL;
}
