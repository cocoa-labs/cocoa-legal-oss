"use client";

import { Fragment, useEffect, useRef, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { CocoaLegalIcon } from "@/components/chat/cocoa-legal-icon";
import {
    fetchSignSession,
    submitSignature,
    SignApiError,
    type SignSession,
    type SignSubmitResult,
} from "../lib/signApi";
import {
    signatureConsentCopy,
    signerPageNotice,
    type SignerPageNotice,
} from "@/app/lib/signatureConsentCopy";
import SignaturePad, { type SignatureMode } from "@/app/components/legal/SignaturePad";

type LoadState =
    | { kind: "loading" }
    | { kind: "error"; title: string; message: string }
    | { kind: "ready"; session: SignSession };

function CocoaMark() {
    return (
        <div className="flex items-center gap-2">
            <CocoaLegalIcon size={28} />
            <span className="font-serif text-lg font-light text-stone-900">
                Cocoa Legal
            </span>
        </div>
    );
}

function Shell({
    children,
    notice,
}: {
    children: React.ReactNode;
    notice: SignerPageNotice;
}) {
    // The public signer page renders on a fixed light surface so it is legible
    // and trustworthy regardless of the visitor's stored theme preference.
    return (
        <main className="flex min-h-dvh flex-col items-center bg-gradient-to-b from-[#efe5d8] to-[#f6f1ea] px-4 pb-2 pt-6 text-stone-900 antialiased">
            <div className="flex w-full max-w-3xl flex-1 flex-col gap-5">
                {children}
            </div>
            <footer className="flex items-center gap-2.5 px-2 pb-3 pt-[18px] text-[12.5px] text-stone-500">
                {notice.footer.map((part, index) => (
                    <Fragment key={part}>
                        {index > 0 ? <span aria-hidden="true">·</span> : null}
                        <span>{part}</span>
                    </Fragment>
                ))}
            </footer>
        </main>
    );
}

function CenteredCard({
    icon,
    title,
    message,
    notice,
    tone = "neutral",
    children,
}: {
    icon: "loading" | "success" | "error";
    title: string;
    message: string;
    notice: SignerPageNotice;
    tone?: "neutral" | "success" | "error";
    children?: React.ReactNode;
}) {
    const badge =
        tone === "success"
            ? "bg-emerald-50 text-emerald-700"
            : tone === "error"
              ? "bg-red-50 text-red-700"
              : "bg-stone-100 text-stone-600";
    return (
        <Shell notice={notice}>
            <header className="flex items-center justify-between gap-4">
                <CocoaMark />
            </header>
            <div className="overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-[0_12px_32px_rgba(42,26,12,0.07)]">
                {notice.banner ? (
                    <div role="status" className="border-b border-amber-200 bg-amber-50 px-6 py-3 text-center text-[13px] font-semibold text-amber-900">
                        {notice.banner}
                    </div>
                ) : null}
                <div className="flex flex-col items-center gap-3 px-7 py-11 text-center">
                    <div
                        className={`flex h-14 w-14 items-center justify-center rounded-full ${badge}`}
                        aria-hidden="true"
                    >
                        {icon === "loading" ? (
                            <CocoaLegalIcon size={30} spin />
                        ) : icon === "success" ? (
                            <svg
                                width="26"
                                height="26"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <path d="M20 6 9 17l-5-5" />
                            </svg>
                        ) : (
                            <svg
                                width="26"
                                height="26"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <path d="M12 9v4" />
                                <path d="M12 17h.01" />
                                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                            </svg>
                        )}
                    </div>
                    <h1 className="max-w-[30ch] font-serif text-[22px] font-normal leading-snug text-stone-900">
                        {title}
                    </h1>
                    <p className="max-w-[46ch] text-[14.5px] leading-relaxed text-stone-500">
                        {message}
                    </p>
                    {children}
                </div>
            </div>
        </Shell>
    );
}

export default function SignPage() {
    const params = useParams<{ token: string }>();
    const rawToken = params?.token;
    const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;

    const [state, setState] = useState<LoadState>({ kind: "loading" });
    const [mode, setMode] = useState<SignatureMode>("type");
    const [typedName, setTypedName] = useState("");
    const [hasDrawing, setHasDrawing] = useState(false);
    const [consent, setConsent] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);
    const [result, setResult] = useState<SignSubmitResult | null>(null);

    const exportRef = useRef<(() => string | null) | null>(null);

    useEffect(() => {
        let cancelled = false;
        if (!token) {
            setState({
                kind: "error",
                title: "Invalid link",
                message: "This signing link is missing its access token.",
            });
            return;
        }
        setState({ kind: "loading" });
        fetchSignSession(token)
            .then((session) => {
                if (cancelled) return;
                // Pre-fill the typed name from the invited signer when present.
                if (session.signer?.name) setTypedName(session.signer.name);
                setState({ kind: "ready", session });
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                if (err instanceof SignApiError) {
                    if (err.status === 410) {
                        setState({
                            kind: "error",
                            title: "This link has expired",
                            message:
                                err.message ||
                                "This signing link is no longer valid. Please contact the sender to request a new one.",
                        });
                        return;
                    }
                    if (err.status === 404) {
                        setState({
                            kind: "error",
                            title: "Link not found",
                            message:
                                err.message ||
                                "We could not find a document for this link. Please check the URL or contact the sender.",
                        });
                        return;
                    }
                    setState({
                        kind: "error",
                        title: "Something went wrong",
                        message: err.message,
                    });
                    return;
                }
                setState({
                    kind: "error",
                    title: "Connection problem",
                    message:
                        "We could not load this document. Please check your connection and try again.",
                });
            });
        return () => {
            cancelled = true;
        };
    }, [token]);

    const canSubmit =
        consent &&
        !submitting &&
        (mode === "type" ? typedName.trim().length > 0 : hasDrawing);

    const handleSubmit = useCallback(
        async (e: React.FormEvent) => {
            e.preventDefault();
            if (!token || !canSubmit) return;
            setSubmitError(null);
            setSubmitting(true);
            try {
                const drawn = mode === "draw";
                const signaturePng = drawn
                    ? (exportRef.current?.() ?? null)
                    : null;
                if (drawn && !signaturePng) {
                    setSubmitError(
                        "Please draw your signature before submitting.",
                    );
                    setSubmitting(false);
                    return;
                }
                const res = await submitSignature(token, {
                    typed_name: typedName.trim(),
                    signature_png: signaturePng,
                    consent: true,
                    drawn,
                });
                setResult(res);
            } catch (err: unknown) {
                if (err instanceof SignApiError) {
                    setSubmitError(err.message);
                } else {
                    setSubmitError(
                        "We could not record your signature. Please check your connection and try again.",
                    );
                }
            } finally {
                setSubmitting(false);
            }
        },
        [token, canSubmit, mode, typedName],
    );

    // --- Render -----------------------------------------------------------

    // Beta wording follows the session's flag; nothing is claimed before it loads.
    const notice = signerPageNotice(
        state.kind === "ready" ? (state.session.signatures_nonbinding ?? true) : null,
    );

    if (state.kind === "loading") {
        return (
            <CenteredCard
                notice={notice}
                icon="loading"
                title="Loading your document"
                message="One moment while we securely retrieve the document for signature."
            />
        );
    }

    if (state.kind === "error") {
        return (
            <CenteredCard
                notice={notice}
                icon="error"
                title={state.title}
                message={state.message}
                tone="error"
            />
        );
    }

    const { session } = state;

    // Success after submit.
    if (result) {
        return (
            <CenteredCard
                notice={notice}
                icon="success"
                title="Thank you — your signature has been recorded."
                message={
                    result.all_complete
                        ? "All parties have now signed. A completed copy will be emailed to everyone."
                        : "A completed copy will be emailed to all parties once everyone has signed."
                }
                tone="success"
            />
        );
    }

    // The document was already completed by all parties. Once completed, the
    // backend hands back inline links to the executed PDF + certificate so the
    // signer can download their copy here (the completion email links to it).
    if (session.completed) {
        const downloads = [
            session.executed_pdf_url
                ? { label: "Executed PDF", href: session.executed_pdf_url }
                : null,
            session.certificate_url
                ? {
                      label: "Certificate of Completion",
                      href: session.certificate_url,
                  }
                : null,
        ].filter((d): d is { label: string; href: string } => d !== null);
        return (
            <CenteredCard
                notice={notice}
                icon="success"
                title="This document is fully executed."
                message={
                    downloads.length > 0
                        ? "All parties have signed. Download your executed copy and the Certificate of Completion below."
                        : "All parties have signed. A completed copy has been emailed to everyone involved."
                }
                tone="success"
            >
                {downloads.length > 0 ? (
                    <div className="mt-5 flex w-full max-w-[20rem] flex-col gap-2.5">
                        {downloads.map((d) => (
                            <a
                                key={d.href}
                                href={d.href}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center justify-center gap-2 rounded-lg bg-amber-700 px-5 py-2.5 text-[14.5px] font-semibold text-white no-underline shadow-sm transition-colors hover:bg-amber-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                            >
                                <svg
                                    width="16"
                                    height="16"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2.2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    aria-hidden="true"
                                >
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                    <path d="M7 10l5 5 5-5" />
                                    <path d="M12 15V3" />
                                </svg>
                                {d.label}
                            </a>
                        ))}
                    </div>
                ) : null}
            </CenteredCard>
        );
    }

    // This signer already signed (but others may still be pending).
    if (session.already_signed || session.signer?.status === "signed") {
        return (
            <CenteredCard
                notice={notice}
                icon="success"
                title="You've already signed this document."
                message="Your signature is on file. A completed copy will be emailed to all parties once everyone has signed."
                tone="success"
            />
        );
    }

    if (session.expired) {
        return (
            <CenteredCard
                notice={notice}
                icon="error"
                title="This link has expired"
                message="This signing link is no longer valid. Please contact the sender to request a new one."
                tone="error"
            />
        );
    }

    // Active signing UI.
    return (
        <Shell notice={notice}>
            <header className="flex items-center justify-between gap-4">
                <CocoaMark />
                {session.signer?.email ? (
                    <span className="max-w-[40vw] truncate text-[13px] text-stone-500">
                        {session.signer.email}
                    </span>
                ) : null}
            </header>

            <div className="overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-[0_12px_32px_rgba(42,26,12,0.07)]">
                {notice.banner ? (
                    <div role="status" className="border-b border-amber-200 bg-amber-50 px-6 py-3 text-center text-[13px] font-semibold text-amber-900">
                        {notice.banner}
                    </div>
                ) : null}
                <div className="px-6 pb-2 pt-6">
                    <h1 className="mb-1.5 font-serif text-[22px] font-normal leading-tight text-stone-900">
                        {session.envelope.subject ||
                            session.envelope.document_name ||
                            "Document for signature"}
                    </h1>
                    <p className="text-[14.5px] leading-relaxed text-stone-500">
                        {session.signer?.name
                            ? `${session.signer.name}, please `
                            : "Please "}
                        review the document below, then add your signature and
                        consent to sign electronically.
                    </p>
                    {session.envelope.message ? (
                        <p className="mt-3.5 whitespace-pre-wrap rounded-lg border border-stone-200 bg-stone-50 px-3.5 py-3 text-[14px] leading-relaxed text-stone-700">
                            {session.envelope.message}
                        </p>
                    ) : null}
                </div>

                <section
                    aria-label="Document preview"
                    className="mt-4 border-t border-stone-200"
                >
                    <div className="flex items-center justify-between gap-3 bg-stone-50/80 px-6 py-3">
                        <span className="truncate text-[13.5px] font-semibold text-amber-900">
                            {session.envelope.document_name || "Document.pdf"}
                        </span>
                        <a
                            href={session.pdf_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="shrink-0 rounded-md px-2 py-1 text-[13px] font-semibold text-amber-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                        >
                            Open in new tab
                        </a>
                    </div>
                    <iframe
                        src={session.pdf_url}
                        title={
                            session.envelope.document_name ||
                            "Document preview"
                        }
                        className="block h-[70vh] min-h-[420px] w-full border-0 border-t border-stone-200 bg-stone-100"
                    />
                </section>

                <form
                    onSubmit={handleSubmit}
                    noValidate
                    className="border-t border-stone-200 px-6 pb-6 pt-5"
                >
                    <h2 className="mb-3.5 text-base font-semibold text-stone-900">
                        Add your signature
                    </h2>

                    <SignaturePad
                        mode={mode}
                        onModeChange={setMode}
                        typedName={typedName}
                        onTypedNameChange={setTypedName}
                        onDrawingChange={setHasDrawing}
                        exportRef={exportRef}
                        disabled={submitting}
                    />

                    <label className="mb-1.5 mt-5 flex cursor-pointer items-start gap-2.5">
                        <input
                            type="checkbox"
                            checked={consent}
                            onChange={(e) => setConsent(e.target.checked)}
                            disabled={submitting}
                            className="mt-0.5 h-[18px] w-[18px] shrink-0 cursor-pointer accent-amber-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                        />
                        <span className="text-[14px] leading-relaxed text-stone-700">
                            {signatureConsentCopy(session.signatures_nonbinding ?? true).checkbox}
                        </span>
                    </label>

                    {submitError ? (
                        <div
                            role="alert"
                            className="mt-3.5 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-[13.5px] leading-snug text-red-700"
                        >
                            {submitError}
                        </div>
                    ) : null}

                    <button
                        type="submit"
                        disabled={!canSubmit}
                        aria-disabled={!canSubmit}
                        className="mt-[18px] w-full rounded-xl bg-gradient-to-br from-amber-600 to-amber-800 px-[18px] py-3.5 text-[15.5px] font-semibold text-white transition hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 active:translate-y-px disabled:cursor-not-allowed disabled:bg-stone-300 disabled:from-stone-300 disabled:to-stone-300 disabled:text-stone-100"
                    >
                        {submitting ? "Submitting…" : "Sign document"}
                    </button>

                    <p className="mt-3.5 text-[12px] leading-relaxed text-stone-500">
                        {signatureConsentCopy(session.signatures_nonbinding ?? true).footnote}
                    </p>
                </form>
            </div>
        </Shell>
    );
}
