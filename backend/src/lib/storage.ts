/**
 * S3-compatible storage utilities for Coco Legal document management.
 * Supports Railway buckets, Cloudflare R2, and similar S3 APIs.
 *
 * Required env vars:
 *   R2_ENDPOINT_URL     — https://<account-id>.r2.cloudflarestorage.com
 *   R2_ACCESS_KEY_ID    — R2 API token (Access Key ID)
 *   R2_SECRET_ACCESS_KEY — R2 API token (Secret Access Key)
 *   R2_BUCKET_NAME      — bucket name (default: "coco-legal")
 */

import {
  S3Client,
  type S3ClientConfig,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import { getSignedUrl as awsGetSignedUrl } from "@aws-sdk/s3-request-presigner";

let cachedClient: S3Client | undefined;

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function clientConfig(endpoint: string | undefined): S3ClientConfig {
  return {
    region: "auto",
    endpoint,
    forcePathStyle: envBool("S3_FORCE_PATH_STYLE", true),
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
    maxAttempts: 4,
    // S3-compatible providers (R2, Tigris/storageapi.dev) don't implement AWS's
    // flexible checksums. The @aws-sdk v3 default (WHEN_SUPPORTED) signs
    // `x-amz-checksum-mode=ENABLED` into presigned GETs; Tigris then returns a
    // response Chrome rejects with ERR_INVALID_RESPONSE. WHEN_REQUIRED only
    // adds a checksum when an operation strictly needs one (none of ours do).
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  };
}

function getClient(): S3Client {
  if (!cachedClient) cachedClient = new S3Client(clientConfig(process.env.R2_ENDPOINT_URL!));
  return cachedClient;
}

/**
 * Endpoint for presigned, browser-facing URLs. Behind Docker Compose the
 * backend reaches storage at an internal host (http://rustfs:9000) that the
 * browser can't resolve; R2_PUBLIC_ENDPOINT_URL lets presigned GETs carry a
 * host the browser can reach. Defaults to R2_ENDPOINT_URL.
 */
export function presignEndpoint(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.R2_PUBLIC_ENDPOINT_URL?.trim() || env.R2_ENDPOINT_URL;
}

let cachedPresignClient: S3Client | undefined;

function getPresignClient(): S3Client {
  const endpoint = presignEndpoint();
  if (endpoint === process.env.R2_ENDPOINT_URL) return getClient();
  if (!cachedPresignClient) cachedPresignClient = new S3Client(clientConfig(endpoint));
  return cachedPresignClient;
}

const BUCKET = process.env.R2_BUCKET_NAME ?? "coco-legal";

export const storageEnabled = Boolean(
  process.env.R2_ENDPOINT_URL &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY,
);

function requireStorageConfig(): void {
  if (!storageEnabled) {
    throw new Error(
      "R2_ENDPOINT_URL, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY must be set",
    );
  }
}

const RETRY_DELAYS_MS = [250, 750, 1500];
const TRANSIENT_STORAGE_PATTERNS = [
  /bad record mac/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /EPIPE/i,
  /network/i,
  /timeout/i,
  /temporarily unavailable/i,
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function storageStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  return (error as { $metadata?: { httpStatusCode?: number } }).$metadata
    ?.httpStatusCode;
}

function storageErrorMessage(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.replace(/\s+/g, " ").slice(0, 240);
}

function isTransientStorageError(error: unknown): boolean {
  const statusCode = storageStatusCode(error);
  if (statusCode && statusCode >= 500) return true;
  const message = storageErrorMessage(error);
  return TRANSIENT_STORAGE_PATTERNS.some((pattern) => pattern.test(message));
}

async function withStorageRetry<T>(
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const shouldRetry =
        attempt < RETRY_DELAYS_MS.length && isTransientStorageError(error);
      if (!shouldRetry) break;

      console.warn("[storage] transient request failed; retrying", {
        label,
        attempt: attempt + 1,
        message: storageErrorMessage(error),
      });
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

/**
 * Cheapest real round-trip to the bucket, used by /health/ready. Throws when
 * storage env is missing or the bucket is unreachable — no retry wrapper, a
 * readiness probe wants the truth now, not after 2.5s of backoff.
 */
export async function checkStorageReachable(): Promise<void> {
  requireStorageConfig();
  await getClient().send(new HeadBucketCommand({ Bucket: BUCKET }));
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export async function uploadFile(
  key: string,
  content: ArrayBuffer,
  contentType: string,
): Promise<void> {
  requireStorageConfig();
  const client = getClient();
  const body = Buffer.from(content);
  await withStorageRetry("put-object", () =>
    client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    ),
  );
}

export async function uploadFileStream(
  key: string,
  content: Readable,
  contentType: string,
  contentLength?: number,
): Promise<void> {
  requireStorageConfig();
  // The SDK owns transport retries. Application-level retries cannot safely
  // replay a consumed stream without reopening the source.
  await getClient().send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: content,
      ContentType: contentType,
      ...(contentLength === undefined ? {} : { ContentLength: contentLength }),
    }),
  );
}

export function quarantineStorageKey(userId: string, uploadId: string): string {
  const safeUser = userId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return `quarantine/${safeUser}/${uploadId}`;
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export async function downloadFile(key: string): Promise<ArrayBuffer | null> {
  if (!storageEnabled) return null;
  try {
    const client = getClient();
    // Retry transient failures like uploadFile does — the body read is inside
    // the retry because a connection reset mid-stream is just as transient as
    // a failed GET.
    return await withStorageRetry("get-object", async () => {
      const response = await client.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: key }),
      );
      if (!response.Body) return null;
      const bytes = await response.Body.transformToByteArray();
      // `bytes` is a VIEW, not a standalone buffer. GIVEN A POOLED VIEW —
      // which Node produces for small reads, as a window into a shared 8 KB
      // pool — `bytes.buffer` is not the object but the whole pool from offset
      // 0, i.e. the wrong bytes entirely (34 bytes of payload read back as
      // 8192 bytes of unrelated pool content). The pinned SDK's stream
      // collector happens to copy into an exact-size buffer today, so this has
      // never fired in production; it is one dependency bump from doing so.
      // Copy out exactly this view's range. Do NOT "simplify" this back to
      // `bytes.buffer`: downloadFile feeds the e-signature path, where the
      // original PDF is SHA-256 hashed into the integrity record.
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
    });
  } catch (error) {
    // Returning null preserves the absent-object contract for callers, but it
    // must never be silent: a swallowed transient R2 error here once stranded
    // a fully-signed e-sign envelope with zero log output (the completion
    // pipeline read this null as "no original PDF" and gave up).
    console.error("[storage] downloadFile failed", {
      key,
      message: storageErrorMessage(error),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteFile(key: string): Promise<void> {
  if (!storageEnabled) return;
  const client = getClient();
  await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

// ---------------------------------------------------------------------------
// Signed URL (pre-signed for temporary direct access)
// ---------------------------------------------------------------------------

export async function getSignedUrl(
  key: string,
  expiresIn = 3600,
  downloadFilename?: string,
  disposition: "inline" | "attachment" = "attachment",
): Promise<string | null> {
  if (!storageEnabled) return null;
  try {
    const client = getPresignClient();
    // Override the response Content-Disposition so the browser uses this
    // filename on download, instead of the last path segment of the R2 key
    // (which includes the document UUID). The `download` attribute on <a>
    // is ignored for cross-origin URLs, so we have to set it server-side.
    // `inline` lets the browser RENDER the PDF in a tab (with download still
    // available from the viewer); `attachment` (default) forces a download.
    const responseContentDisposition = downloadFilename
      ? buildQuerySafeContentDisposition(disposition, downloadFilename)
      : undefined;
    const command = new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ResponseContentDisposition: responseContentDisposition,
    });
    return await awsGetSignedUrl(client, command, { expiresIn });
  } catch {
    return null;
  }
}

export function normalizeDownloadFilename(name: string): string {
  const trimmed = name.trim();
  const base = trimmed || "download";
  return base.replace(/[\x00-\x1F\x7F]/g, "_").replace(/[\\/]/g, "_");
}

export function sanitizeDispositionFilename(name: string): string {
  return normalizeDownloadFilename(name)
    .replace(/["\\]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_");
}

export function encodeRFC5987(str: string): string {
  return encodeURIComponent(str).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

export function buildContentDisposition(
  kind: "inline" | "attachment",
  filename: string,
): string {
  const normalized = normalizeDownloadFilename(filename);
  return `${kind}; filename="${sanitizeDispositionFilename(normalized)}"; filename*=UTF-8''${encodeRFC5987(normalized)}`;
}

/**
 * Content-Disposition for a value that goes into a PRESIGNED URL query param
 * (ResponseContentDisposition), not a real response header. The presigner
 * percent-encodes the whole value again, so an RFC5987 `filename*` (with `%`
 * escapes) becomes double-encoded (`%20`→`%2520`) — and S3-compatible providers
 * like Tigris don't unwrap the extra layer, yielding a garbled download name.
 * Emit only the ASCII `filename="..."` token, which round-trips cleanly. Our
 * filenames are already ASCII-sanitized for that token, so nothing is lost.
 */
export function buildQuerySafeContentDisposition(
  kind: "inline" | "attachment",
  filename: string,
): string {
  const normalized = normalizeDownloadFilename(filename);
  return `${kind}; filename="${sanitizeDispositionFilename(normalized)}"`;
}

// ---------------------------------------------------------------------------
// Storage key helpers
// ---------------------------------------------------------------------------

export function storageKey(
  userId: string,
  docId: string,
  filename: string,
): string {
  return `documents/${userId}/${docId}/source${storageExtension(filename, ".bin")}`;
}

export function pdfStorageKey(
  userId: string,
  docId: string,
  stem: string,
): string {
  return `documents/${userId}/${docId}/${stem}.pdf`;
}

export function generatedDocKey(
  userId: string,
  docId: string,
  filename: string,
): string {
  return `generated/${userId}/${docId}/generated${storageExtension(filename, ".docx")}`;
}

export function versionStorageKey(
  userId: string,
  docId: string,
  versionSlug: string,
  filename: string,
): string {
  return `documents/${userId}/${docId}/versions/${versionSlug}${storageExtension(filename, ".bin")}`;
}

/**
 * Storage key for a captured recording's raw audio. Mirrors the document key
 * builders above — a per-user prefix plus a caller-generated random object id
 * (the route passes crypto.randomUUID()) — with the trusted audio extension as
 * the suffix. `ext` is the server-derived audio extension (from
 * mimeForAudioExtension's family), NOT the browser filename; an empty ext drops
 * the dot rather than leaving a dangling one.
 */
export function recordingAudioKey(
  userId: string,
  uniqueId: string,
  ext: string,
): string {
  const suffix = ext.replace(/^\.+/, "").toLowerCase();
  return suffix
    ? `recordings/${userId}/${uniqueId}.${suffix}`
    : `recordings/${userId}/${uniqueId}`;
}

function storageExtension(filename: string, fallback: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot < 0) return fallback;
  const ext = filename.slice(lastDot).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/.test(ext) ? ext : fallback;
}

// ---------------------------------------------------------------------------
// E-signature artifact keys
//   signatures/{userId}/{envelopeId}/original.pdf      — flattened PDF sent for signing
//   signatures/{userId}/{envelopeId}/executed.pdf      — stamped + cryptographically signed PDF
//   signatures/{userId}/{envelopeId}/certificate.pdf   — Certificate of Completion (audit page)
//   signatures/{userId}/{envelopeId}/signers/{signerId}/signature.png — captured signature image
// ---------------------------------------------------------------------------

export function signatureOriginalKey(userId: string, envelopeId: string): string {
  return `signatures/${userId}/${envelopeId}/original.pdf`;
}

export function signatureExecutedKey(userId: string, envelopeId: string): string {
  return `signatures/${userId}/${envelopeId}/executed.pdf`;
}

export function signatureCertificateKey(userId: string, envelopeId: string): string {
  return `signatures/${userId}/${envelopeId}/certificate.pdf`;
}

export function signerSignatureImageKey(
  userId: string,
  envelopeId: string,
  signerId: string,
): string {
  return `signatures/${userId}/${envelopeId}/signers/${signerId}/signature.png`;
}
