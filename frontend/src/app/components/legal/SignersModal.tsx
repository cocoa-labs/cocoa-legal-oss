"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
    X,
    UserPlus,
    Loader2,
    Plus,
    FileSignature,
    Trash2,
    ArrowRight,
    ArrowLeft,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { signatureConsentCopy } from "@/app/lib/signatureConsentCopy";
import { useSignaturesNonbinding } from "@/app/lib/useSignaturesNonbinding";
import {
    createSignatureRequest,
    signSelf,
    type SignatureEnvelopeDetail,
} from "@/app/lib/cocoLegalApi";
import { SignatureStatusCard } from "./SignatureStatusCard";
import { FieldPlacer, type PlacedField, type PlacerSigner } from "./FieldPlacer";
import SignaturePad, { type SignatureMode } from "./SignaturePad";

interface Props {
    open: boolean;
    onClose: () => void;
    documentId: string;
    filename: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type SignerRow = {
    /** Stable key so React doesn't reorder inputs as rows are added/removed. */
    key: string;
    name: string;
    email: string;
};

let rowSeq = 0;
function newRow(): SignerRow {
    rowSeq += 1;
    return { key: `signer-${rowSeq}`, name: "", email: "" };
}

/**
 * Non-chat "Send for signature" action. Modeled on PeopleModal's frame
 * (portal to body, backdrop, Esc / click-out close). Collects signer rows +
 * subject/message, optionally adds the signed-in user as a countersigner, then
 * POSTs to `/signatures`. On success the form body is swapped for a live
 * `SignatureStatusCard` so the sender watches links go out and can countersign
 * in-app immediately.
 */
export function SignersModal({ open, onClose, documentId, filename }: Props) {
    const { user } = useAuth();
    const signaturesNonbinding = useSignaturesNonbinding();
    const selfEmail = user?.email ?? null;

    const [rows, setRows] = useState<SignerRow[]>([newRow()]);
    const [subject, setSubject] = useState("");
    const [message, setMessage] = useState("");
    const [includeSelf, setIncludeSelf] = useState(false);
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sent, setSent] = useState<SignatureEnvelopeDetail | null>(null);
    const [step, setStep] = useState<"form" | "place">("form");
    const [placedFields, setPlacedFields] = useState<PlacedField[]>([]);

    // Sender's own signature, captured in-modal when "I'll countersign" is on,
    // so they sign once up front (applied via signSelf right after the send) and
    // never return for a trailing in-app step.
    const [signMode, setSignMode] = useState<SignatureMode>("type");
    const [signTypedName, setSignTypedName] = useState("");
    const [signHasDrawing, setSignHasDrawing] = useState(false);
    const [signConsent, setSignConsent] = useState(false);
    const signExportRef = useRef<(() => string | null) | null>(null);

    // Reset all internal state whenever the modal closes (or the target doc
    // changes), so the next open starts from a clean form.
    useEffect(() => {
        if (open) {
            setRows([newRow()]);
            setSubject(`Please sign: ${filename}`);
            setMessage("");
            setIncludeSelf(false);
            setSending(false);
            setError(null);
            setSent(null);
            setStep("form");
            setPlacedFields([]);
            setSignMode("type");
            setSignTypedName("");
            setSignHasDrawing(false);
            setSignConsent(false);
        }
    }, [open, filename, documentId]);

    // Esc to close (disabled mid-send so an in-flight request isn't abandoned).
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape" && !sending) onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open, sending, onClose]);

    const selfLower = selfEmail?.trim().toLowerCase() ?? null;

    // Per-row validity + duplicate detection across the entered emails (and the
    // self email when countersigning), so we can show targeted inline errors.
    const rowState = useMemo(() => {
        const seen = new Map<string, number>();
        if (includeSelf && selfLower) seen.set(selfLower, -1);
        return rows.map((row, i) => {
            const email = row.email.trim();
            const lower = email.toLowerCase();
            const hasInput = email.length > 0 || row.name.trim().length > 0;
            const validEmail = EMAIL_RE.test(lower);
            const duplicate = !!lower && seen.has(lower);
            if (lower && !seen.has(lower)) seen.set(lower, i);
            return { hasInput, email, validEmail, duplicate };
        });
    }, [rows, includeSelf, selfLower]);

    const validSignerCount = rowState.filter(
        (r) => r.validEmail && !r.duplicate,
    ).length;
    const hasRowErrors = rowState.some(
        (r) => r.hasInput && (!r.validEmail || r.duplicate),
    );
    const canSend =
        !sending &&
        !hasRowErrors &&
        (validSignerCount > 0 || (includeSelf && !!selfLower));

    // The people who will actually sign (valid rows + self) — drives the field
    // placer's per-signer assignment. Emails match what the backend creates.
    const effectiveSigners: PlacerSigner[] = useMemo(() => {
        const out: PlacerSigner[] = [];
        const seen = new Set<string>();
        rows.forEach((r, i) => {
            if (!rowState[i]?.validEmail || rowState[i]?.duplicate) return;
            const email = r.email.trim();
            const key = email.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            out.push({ email, name: r.name.trim() || email });
        });
        if (includeSelf && selfEmail) {
            const key = selfEmail.trim().toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                out.push({ email: selfEmail.trim(), name: "You" });
            }
        }
        return out;
    }, [rows, rowState, includeSelf, selfEmail]);

    // Drop placed fields whose signer no longer exists (email edited/removed).
    useEffect(() => {
        const emails = new Set(effectiveSigners.map((s) => s.email));
        setPlacedFields((prev) => {
            const next = prev.filter((f) => emails.has(f.signerEmail));
            return next.length === prev.length ? prev : next;
        });
    }, [effectiveSigners]);

    // The sender has staged a usable countersignature in the modal.
    const selfSignatureReady =
        includeSelf &&
        !!selfEmail &&
        signConsent &&
        (signMode === "type"
            ? signTypedName.trim().length > 0
            : signHasDrawing);

    if (!open) return null;

    const updateRow = (key: string, patch: Partial<SignerRow>) => {
        setRows((prev) =>
            prev.map((r) => (r.key === key ? { ...r, ...patch } : r)),
        );
    };
    const addRow = () => setRows((prev) => [...prev, newRow()]);
    const removeRow = (key: string) =>
        setRows((prev) =>
            prev.length <= 1 ? prev : prev.filter((r) => r.key !== key),
        );

    async function handleSend(useFields = true) {
        if (!canSend) return;
        setSending(true);
        setError(null);
        try {
            const signers = rows
                .filter(
                    (_, i) => rowState[i].validEmail && !rowState[i].duplicate,
                )
                .map((r) => ({
                    name: r.name.trim() || r.email.trim(),
                    email: r.email.trim(),
                    role: "signer" as const,
                }));
            const fields =
                useFields && placedFields.length > 0
                    ? placedFields.map((f) => ({
                          signer_email: f.signerEmail,
                          type: f.type,
                          page: f.page,
                          x_pct: f.xPct,
                          y_pct: f.yPct,
                          w_pct: f.wPct,
                          h_pct: f.hPct,
                      }))
                    : undefined;
            const resp = await createSignatureRequest({
                document_id: documentId,
                signers,
                subject: subject.trim() || undefined,
                message: message.trim() || undefined,
                include_self_as_signer: includeSelf || undefined,
                fields,
            });
            // If the sender staged a signature in the modal, apply it now so
            // they sign once, up front — no trailing in-app countersign step.
            // Non-fatal: the envelope is already sent and the status card's
            // "It's your turn — Sign" button remains as a fallback on failure.
            if (selfSignatureReady) {
                try {
                    const drawn = signMode === "draw";
                    const signature_png = drawn
                        ? (signExportRef.current?.() ?? null)
                        : null;
                    if (!(drawn && !signature_png)) {
                        await signSelf(resp.envelope.id, {
                            typed_name: signTypedName.trim(),
                            signature_png,
                            consent: true,
                            drawn,
                        });
                    }
                } catch {
                    // Keep the sent state; fall back to in-app countersign.
                }
            }
            setSent(resp);
        } catch (e) {
            setError(
                e instanceof Error
                    ? e.message
                    : "Couldn't send for signature. Try again.",
            );
        } finally {
            setSending(false);
        }
    }

    return createPortal(
        <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/10 backdrop-blur-xs"
            onMouseDown={(e) => {
                // Click-out closes, but not while a send is in flight.
                if (e.target === e.currentTarget && !sending) onClose();
            }}
        >
            <div
                className={`flex max-h-[90vh] w-full flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ${
                    step === "place" && !sent ? "max-w-5xl" : "max-w-xl"
                }`}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4">
                    <div className="flex items-center gap-2">
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-purple-100 text-purple-700 ring-1 ring-purple-200">
                            <FileSignature className="h-3.5 w-3.5" />
                        </div>
                        <div className="min-w-0">
                            <h2 className="text-sm font-semibold text-gray-900">
                                {sent
                                    ? "Sent for signature"
                                    : step === "place"
                                      ? "Place signature fields"
                                      : "Send for signature"}
                            </h2>
                            <p className="truncate text-xs text-gray-400">
                                {filename}
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        disabled={sending}
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50"
                        title="Close"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {sent ? (
                    /* Success: live status card so the user watches links go out
                       and can countersign in-app right here. */
                    <>
                        <div className="flex-1 overflow-y-auto px-5 pb-4">
                            <SignatureStatusCard
                                envelopeId={sent.envelope.id}
                                initialSigners={sent.signers}
                            />
                        </div>
                        <div className="flex justify-end px-5 py-3">
                            <button
                                onClick={onClose}
                                className="rounded-lg border border-gray-900 bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
                            >
                                Done
                            </button>
                        </div>
                    </>
                ) : step === "place" ? (
                    /* Step 2: visual field placement on the rendered document. */
                    <>
                        <div className="flex min-h-0 flex-1 flex-col px-5 pb-2">
                            <FieldPlacer
                                documentId={documentId}
                                signers={effectiveSigners}
                                fields={placedFields}
                                onChange={setPlacedFields}
                            />
                            {error && (
                                <div
                                    role="alert"
                                    className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] leading-snug text-red-700"
                                >
                                    {error}
                                </div>
                            )}
                        </div>
                        <div className="flex items-center justify-between px-5 py-3">
                            <button
                                onClick={() => setStep("form")}
                                disabled={sending}
                                className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50"
                            >
                                <ArrowLeft className="h-3.5 w-3.5" />
                                Back
                            </button>
                            <div className="flex items-center gap-2.5">
                                <span className="text-xs text-gray-400">
                                    {placedFields.length === 0
                                        ? "No fields placed — we'll auto-place."
                                        : `${placedFields.length} field${
                                              placedFields.length === 1
                                                  ? ""
                                                  : "s"
                                          } placed`}
                                </span>
                                <button
                                    onClick={() => void handleSend(true)}
                                    disabled={sending}
                                    className="inline-flex items-center gap-1.5 rounded-lg border border-gray-900 bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
                                >
                                    {sending ? (
                                        <>
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                            Sending…
                                        </>
                                    ) : (
                                        <>
                                            <FileSignature className="h-3.5 w-3.5" />
                                            {selfSignatureReady
                                                ? "Sign & send"
                                                : "Send for signature"}
                                        </>
                                    )}
                                </button>
                            </div>
                        </div>
                    </>
                ) : (
                    <>
                        <div className="flex-1 overflow-y-auto px-5 pb-2">
                            {/* Signer rows */}
                            <label className="mb-1.5 block text-xs font-medium text-gray-500">
                                Signers
                            </label>
                            <div className="space-y-2">
                                {rows.map((row, i) => {
                                    const st = rowState[i];
                                    const showError =
                                        st.hasInput &&
                                        (!st.validEmail || st.duplicate);
                                    return (
                                        <div key={row.key}>
                                            <div className="flex items-center gap-2">
                                                <input
                                                    type="text"
                                                    placeholder="Name"
                                                    value={row.name}
                                                    onChange={(e) =>
                                                        updateRow(row.key, {
                                                            name: e.target.value,
                                                        })
                                                    }
                                                    className="w-2/5 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700 placeholder:text-gray-400 outline-none focus:border-gray-400"
                                                />
                                                <div className="flex flex-1 items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                                                    <UserPlus className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                                                    <input
                                                        type="email"
                                                        placeholder="email@company.com"
                                                        value={row.email}
                                                        onChange={(e) =>
                                                            updateRow(row.key, {
                                                                email: e.target
                                                                    .value,
                                                            })
                                                        }
                                                        onKeyDown={(e) => {
                                                            if (
                                                                e.key === "Enter"
                                                            )
                                                                void handleSend();
                                                        }}
                                                        className="flex-1 bg-transparent text-sm text-gray-700 placeholder:text-gray-400 outline-none"
                                                    />
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        removeRow(row.key)
                                                    }
                                                    disabled={rows.length <= 1}
                                                    title="Remove signer"
                                                    className="rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-400"
                                                >
                                                    <Trash2 className="h-3.5 w-3.5" />
                                                </button>
                                            </div>
                                            {showError && (
                                                <p className="mt-1 pl-1 text-xs text-red-500">
                                                    {st.duplicate
                                                        ? "Duplicate email."
                                                        : "Enter a valid email."}
                                                </p>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                            <button
                                type="button"
                                onClick={addRow}
                                className="mt-2 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                            >
                                <Plus className="h-3.5 w-3.5" />
                                Add signer
                            </button>

                            {/* Countersign self */}
                            {selfEmail && (
                                <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5">
                                    <input
                                        type="checkbox"
                                        checked={includeSelf}
                                        onChange={(e) =>
                                            setIncludeSelf(e.target.checked)
                                        }
                                        className="mt-0.5 h-[18px] w-[18px] shrink-0 cursor-pointer accent-gray-900"
                                    />
                                    <span className="text-[13px] leading-snug text-gray-700">
                                        I&apos;ll countersign (add me as a signer)
                                        <span className="ml-1 text-gray-400">
                                            — {selfEmail}
                                        </span>
                                    </span>
                                </label>
                            )}

                            {/* Sender's own signature, captured up front so they
                               sign once and never return for a trailing step. */}
                            {includeSelf && selfEmail && (
                                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/40 p-3">
                                    <div className="mb-2 text-xs font-medium text-amber-900">
                                        Your signature
                                        <span className="ml-1 font-normal text-amber-700/70">
                                            — sign now so you don&apos;t have to come back
                                        </span>
                                    </div>
                                    <SignaturePad
                                        mode={signMode}
                                        onModeChange={setSignMode}
                                        typedName={signTypedName}
                                        onTypedNameChange={setSignTypedName}
                                        onDrawingChange={setSignHasDrawing}
                                        exportRef={signExportRef}
                                        disabled={sending}
                                    />
                                    <label className="mt-2.5 flex cursor-pointer items-start gap-2.5">
                                        <input
                                            type="checkbox"
                                            checked={signConsent}
                                            onChange={(e) =>
                                                setSignConsent(e.target.checked)
                                            }
                                            className="mt-0.5 h-[18px] w-[18px] shrink-0 cursor-pointer accent-amber-700"
                                        />
                                        <span className="text-[12px] leading-snug text-gray-600">
                                            {signatureConsentCopy(signaturesNonbinding).checkbox}
                                        </span>
                                    </label>
                                    {!selfSignatureReady && (
                                        <p className="mt-1.5 text-[11px] text-amber-700/80">
                                            Optional — or leave blank and
                                            you&apos;ll be prompted to countersign
                                            in-app after sending.
                                        </p>
                                    )}
                                </div>
                            )}

                            {/* Subject */}
                            <label className="mb-1.5 mt-4 block text-xs font-medium text-gray-500">
                                Subject
                            </label>
                            <input
                                type="text"
                                value={subject}
                                onChange={(e) => setSubject(e.target.value)}
                                placeholder={`Please sign: ${filename}`}
                                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700 placeholder:text-gray-400 outline-none focus:border-gray-400"
                            />

                            {/* Message */}
                            <label className="mb-1.5 mt-3 block text-xs font-medium text-gray-500">
                                Message{" "}
                                <span className="font-normal text-gray-400">
                                    (optional)
                                </span>
                            </label>
                            <textarea
                                value={message}
                                onChange={(e) => setMessage(e.target.value)}
                                rows={3}
                                placeholder="Add a note for the signers…"
                                className="w-full resize-none rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700 placeholder:text-gray-400 outline-none focus:border-gray-400"
                            />

                            {error && (
                                <div
                                    role="alert"
                                    className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] leading-snug text-red-700"
                                >
                                    {error}
                                </div>
                            )}
                        </div>

                        {/* Footer */}
                        <div className="flex items-center justify-end gap-2 px-5 py-3">
                            <button
                                onClick={onClose}
                                disabled={sending}
                                className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={() => void handleSend(false)}
                                disabled={!canSend}
                                title="Skip placement — signatures auto-place on the document's signature lines"
                                className="rounded-lg px-3 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {sending ? "Sending…" : "Send without placing"}
                            </button>
                            <button
                                onClick={() => setStep("place")}
                                disabled={!canSend}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-900 bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                <FileSignature className="h-3.5 w-3.5" />
                                Place fields
                                <ArrowRight className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>,
        document.body,
    );
}
