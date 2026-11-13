/**
 * Self-contained API helper for the public signer-facing page.
 *
 * This intentionally does NOT depend on the app's main api client
 * (`@/app/lib/cocoLegalApi`). The signing page is opened by an external signer via
 * a single-use magic link with no auth, so it must stay free of Supabase/session
 * imports and send no Authorization header.
 *
 * The backend base URL comes from the shared `@/app/lib/apiBase` module — the
 * same `NEXT_PUBLIC_API_BASE_URL` source the rest of the app uses. That module
 * has no Supabase/session dependency, so importing it keeps this page auth-free
 * while still pointing at the same backend.
 */

import { API_BASE } from '@/app/lib/apiBase';

export function resolveBackendBaseUrl(): string {
  // `API_BASE` already has trailing slashes stripped, so it joins cleanly
  // with `/sign/...`.
  return API_BASE;
}

export interface SignEnvelope {
  id: string;
  subject: string;
  message: string;
  document_name: string;
  status: string;
  expires_at: string;
}

export interface SignSigner {
  id: string;
  name: string;
  email: string;
  status: string;
}

export interface SignSession {
  envelope: SignEnvelope;
  signer: SignSigner;
  pdf_url: string;
  // Present only once the envelope is completed: inline pre-signed links to the
  // executed PDF and the Certificate of Completion, served by GET /sign/:token.
  executed_pdf_url?: string | null;
  certificate_url?: string | null;
  already_signed: boolean;
  expired: boolean;
  completed: boolean;
  // Whether this envelope's signatures are labelled nonbinding (controlled
  // beta). Older backends omit it; treat absence as nonbinding.
  signatures_nonbinding?: boolean;
}

export interface SignSubmitPayload {
  typed_name: string;
  signature_png: string | null;
  consent: true;
  drawn: boolean;
}

export interface SignSubmitResult {
  ok: true;
  status: 'signed';
  all_complete: boolean;
}

/**
 * A normalized error carrying the HTTP status so callers can distinguish
 * expired (410) / not-found (404) / generic 4xx states.
 */
export class SignApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'SignApiError';
    this.status = status;
  }
}

async function parseJsonSafe(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function extractError(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'error' in body) {
    const err = (body as { error?: unknown }).error;
    if (typeof err === 'string' && err.trim()) return err;
  }
  return fallback;
}

export async function fetchSignSession(token: string): Promise<SignSession> {
  const base = resolveBackendBaseUrl();
  const res = await fetch(`${base}/sign/${encodeURIComponent(token)}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });

  const body = await parseJsonSafe(res);
  if (!res.ok) {
    throw new SignApiError(
      extractError(body, 'This signing link is invalid or unavailable.'),
      res.status,
    );
  }
  return body as SignSession;
}

export async function submitSignature(
  token: string,
  payload: SignSubmitPayload,
): Promise<SignSubmitResult> {
  const base = resolveBackendBaseUrl();
  const res = await fetch(`${base}/sign/${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const body = await parseJsonSafe(res);
  if (!res.ok) {
    throw new SignApiError(
      extractError(body, 'We could not record your signature. Please try again.'),
      res.status,
    );
  }
  return body as SignSubmitResult;
}
