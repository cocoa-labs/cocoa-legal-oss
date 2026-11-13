type FetchLike = typeof fetch;

type ProtectedDownloadOptions = {
    apiBase: string;
    downloadUrl: string;
    filename: string;
    getAccessToken: () => Promise<string | null>;
    refreshAccessToken?: () => Promise<string | null>;
    fetchImpl?: FetchLike;
    saveBlob?: (blob: Blob, filename: string) => void | Promise<void>;
};

export class ProtectedDownloadError extends Error {
    readonly status: number | null;

    constructor(message: string, status: number | null = null) {
        super(message);
        this.name = "ProtectedDownloadError";
        this.status = status;
    }
}

function resolveProtectedDownloadUrl(apiBase: string, downloadUrl: string) {
    if (!downloadUrl.startsWith("/") || downloadUrl.startsWith("//")) {
        throw new ProtectedDownloadError("The download link is invalid.");
    }

    let base: URL;
    let resolved: URL;
    try {
        base = new URL(apiBase);
        resolved = new URL(`${apiBase.replace(/\/+$/, "")}${downloadUrl}`);
    } catch {
        throw new ProtectedDownloadError("The download link is invalid.");
    }

    if (resolved.origin !== base.origin) {
        throw new ProtectedDownloadError("The download link is invalid.");
    }
    return resolved.toString();
}

function saveBlobInBrowser(blob: Blob, filename: string) {
    const blobUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1_000);
}

async function requestDownload(
    fetchImpl: FetchLike,
    url: string,
    accessToken: string,
) {
    return fetchImpl(url, {
        cache: "no-store",
        headers: { Authorization: `Bearer ${accessToken}` },
    });
}

function downloadFailureMessage(status: number) {
    if (status === 401) {
        return "Your session expired. Refresh the page and try the download again.";
    }
    if (status === 403 || status === 404) {
        return "This document is no longer available to this account.";
    }
    if (status === 409 || status === 503) {
        return "The document is temporarily unavailable. Please try the download again.";
    }
    return `The document could not be downloaded (HTTP ${status}).`;
}

/**
 * Download a protected backend artifact without navigating the browser to an
 * endpoint that requires an Authorization header. A single token refresh is
 * attempted for stale sessions, and only same-origin backend-relative URLs are
 * eligible to receive the bearer token.
 */
export async function downloadProtectedFile({
    apiBase,
    downloadUrl,
    filename,
    getAccessToken,
    refreshAccessToken,
    fetchImpl = fetch,
    saveBlob = saveBlobInBrowser,
}: ProtectedDownloadOptions) {
    const url = resolveProtectedDownloadUrl(apiBase, downloadUrl);
    let accessToken = await getAccessToken();
    if (!accessToken) {
        throw new ProtectedDownloadError(
            "Your session expired. Refresh the page and try the download again.",
            401,
        );
    }

    let response = await requestDownload(fetchImpl, url, accessToken);
    if (response.status === 401 && refreshAccessToken) {
        accessToken = (await refreshAccessToken()) ?? "";
        if (accessToken) {
            response = await requestDownload(fetchImpl, url, accessToken);
        }
    }

    if (!response.ok) {
        throw new ProtectedDownloadError(
            downloadFailureMessage(response.status),
            response.status,
        );
    }

    const contentType = response.headers.get("content-type")?.toLowerCase();
    if (contentType?.includes("application/json")) {
        throw new ProtectedDownloadError(
            "The server returned an invalid document response. Please try again.",
        );
    }

    const blob = await response.blob();
    if (blob.size === 0) {
        throw new ProtectedDownloadError(
            "The server returned an empty document. Please try again.",
        );
    }
    await saveBlob(blob, filename);
}
