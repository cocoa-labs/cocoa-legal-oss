"use client";

import { useEffect, useState } from "react";
import { Loader2, Paperclip } from "lucide-react";
import {
  fetchEmailAttachmentContent,
  getInboundEmailAttachmentManifest,
  retryEmailAttachment,
  type EmailAttachmentRef,
  type InboundEmailAttachment,
} from "@/app/lib/cocoLegalApi";

export function EmailAttachmentList({
  emailId,
  inbound,
  manifest,
  fallback = [],
}: {
  emailId: string;
  inbound: boolean;
  manifest?: InboundEmailAttachment[];
  fallback?: EmailAttachmentRef[];
}) {
  const [loaded, setLoaded] = useState<{
    emailId: string;
    rows: InboundEmailAttachment[];
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!inbound) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const value = await getInboundEmailAttachmentManifest(emailId);
        if (cancelled) return;
        setLoaded({ emailId, rows: value.attachments });
        if (
          value.attachments.some((row) =>
            ["pending", "processing"].includes(row.status),
          )
        )
          timer = setTimeout(() => void refresh(), 10_000);
      } catch {
        if (!cancelled) setError("Attachment status could not be loaded.");
      }
    };
    if (
      !manifest ||
      (!manifest.length && fallback.length > 0) ||
      manifest.some((row) => ["pending", "processing"].includes(row.status))
    )
      void refresh();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [emailId, inbound, manifest, fallback.length]);
  const rows =
    (loaded?.emailId === emailId ? loaded.rows : null) ??
    (manifest?.length ? manifest : null) ??
    fallback.map((ref, index) => ({
      ...ref,
      attachment_id: String(index),
      index,
      status: "ready" as const,
      retryable: false,
      detail: null,
    }));
  async function open(id: string, filename: string) {
    setBusy(id);
    setError(null);
    try {
      const blob = await fetchEmailAttachmentContent(emailId, id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not open attachment.",
      );
    } finally {
      setBusy(null);
    }
  }
  async function retry(id: string) {
    setBusy(id);
    setError(null);
    try {
      await retryEmailAttachment(emailId, id);
      setLoaded({
        emailId,
        rows: (await getInboundEmailAttachmentManifest(emailId)).attachments,
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not retry attachment.",
      );
    } finally {
      setBusy(null);
    }
  }
  return (
    <div
      className="mt-2 space-y-2"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {rows.map((row) => (
        <div
          key={row.attachment_id}
          className="flex flex-wrap items-center gap-2 text-xs"
        >
          <button
            type="button"
            onClick={() => void open(row.attachment_id, row.filename)}
            disabled={
              busy === row.attachment_id ||
              !["ready", "partial", "unsupported"].includes(row.status)
            }
            title={row.detail ?? `Open ${row.filename}`}
            className="inline-flex max-w-full items-center gap-1 rounded border border-[var(--app-border)] px-2 py-1 disabled:opacity-60"
          >
            {busy === row.attachment_id ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Paperclip className="h-3 w-3" />
            )}
            <span className="truncate">{row.filename}</span>
          </button>
          <span className="text-[var(--app-text-subtle)]">
            {row.status === "pending"
              ? "Waiting to process"
              : row.status === "ready"
                ? "Ready to read"
                : row.status}
          </span>
          {row.retryable && row.status !== "processing" && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void retry(row.attachment_id)}
              className="underline"
            >
              Retry
            </button>
          )}
          {row.detail && (
            <span className="w-full text-[var(--app-text-subtle)]">
              {row.detail}
            </span>
          )}
        </div>
      ))}
      {error && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
