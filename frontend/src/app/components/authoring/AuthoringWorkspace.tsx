"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, FileSignature, PenLine } from "lucide-react";
import { getDocumentUrl, getProject } from "@/app/lib/cocoLegalApi";
import type { CocoLegalProject, DraftQAFinding } from "@/app/components/shared/types";
import { MatterNav } from "@/app/components/projects/MatterNav";
import { AppBackButton } from "@/app/components/shared/AppBackButton";
import { DocView } from "@/app/components/shared/DocView";
import { DocxView } from "@/app/components/shared/DocxView";
import { SignersModal } from "@/app/components/legal/SignersModal";
import {
    matterDocReviewHref,
    matterDocumentsHref,
} from "@/app/lib/matterRoutes";
import { NewDraftModal } from "./NewDraftModal";
import { DraftFindingsPanel } from "./DraftFindingsPanel";
import type { QaStatus } from "./qaShared";

interface Props {
    projectId: string;
}

/** The document currently shown in the center pane. */
interface ViewerDoc {
    documentId: string;
    versionId?: string | null;
    filename: string;
}

function isDocxFile(filename: string) {
    const ext = filename.split(".").pop()?.toLowerCase();
    return ext === "docx" || ext === "doc";
}

/**
 * The matter-scoped AUTHORING workspace (T23). A focused surface — NOT the full
 * three-pane redline workspace — for drafting a document into a project, viewing
 * the produced draft in-app, scanning its four-guardrail QA findings, and
 * sending it for signature.
 *
 * Reuse, not rebuild:
 *  - The center pane renders the SAME shared viewer DocumentReviewWorkspace uses
 *    (DocxView for .docx/.doc, DocView otherwise), keyed by document_id and
 *    fetching bytes itself by documentId/versionId (via useFetchDocxBytes /
 *    useFetchSingleDoc inside those components).
 *  - "Send for signature" mounts the SAME <SignersModal> with the identical
 *    `{ open, onClose, documentId, filename }` prop contract.
 *
 * The drafting itself runs through the existing <NewDraftModal> wizard, scoped
 * to this project. We extended its `onDrafted` to also carry the QA result so
 * the findings rail here renders without re-running QA.
 *
 * Redline refinement of an authored draft happens in the existing Doc Review
 * tab — the authored doc is a first-class project document and appears in the
 * Matter Explorer there — so there's intentionally no redlining surface here.
 */
export function AuthoringWorkspace({ projectId }: Props) {
    const router = useRouter();

    const [project, setProject] = useState<CocoLegalProject | null>(null);
    const [draftOpen, setDraftOpen] = useState(false);

    // The draft shown in the center pane.
    const [viewerDoc, setViewerDoc] = useState<ViewerDoc | null>(null);
    // QA result for the latest draft (captured off NewDraftModal.onDrafted).
    const [qaStatus, setQaStatus] = useState<QaStatus | null>(null);
    const [qaFindings, setQaFindings] = useState<DraftQAFinding[]>([]);

    // Host for the reused "Send for signature" modal.
    const [signFor, setSignFor] = useState<{
        documentId: string;
        filename: string;
    } | null>(null);

    useEffect(() => {
        let cancelled = false;
        getProject(projectId)
            .then((loaded) => {
                if (!cancelled) setProject(loaded);
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [projectId]);

    const handleExport = async () => {
        if (!viewerDoc) return;
        const { url, filename } = await getDocumentUrl(
            viewerDoc.documentId,
            viewerDoc.versionId ?? null,
            "export",
        );
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
    };

    const hasQa = qaStatus !== null;
    const currentRole = project?.current_user_role;
    const canMutate =
        currentRole === "owner" ||
        currentRole === "admin" ||
        currentRole === "lawyer" ||
        currentRole === "editor";
    const canExport = Boolean(currentRole && currentRole !== "viewer");

    return (
        <div className="flex h-full flex-col bg-[var(--app-shell)] text-[var(--app-text)]">
            {/* Page header */}
            <div className="flex shrink-0 items-center justify-between border-b border-[var(--app-border)] bg-[var(--app-shell-subtle)] px-8 py-4 shadow-[var(--app-elevated-shadow)]">
                <div className="flex min-w-0 items-center gap-2">
                    <AppBackButton variant="dark" />
                    <div className="flex min-w-0 items-center gap-1.5 text-2xl font-medium font-serif">
                        <button
                            className="text-[var(--app-text-muted)] transition-colors hover:text-[var(--app-text-strong)]"
                            onClick={() => router.push("/projects")}
                        >
                            Matters
                        </button>
                        <span className="text-[var(--app-text-subtle)]">›</span>
                        {project ? (
                            <button
                                onClick={() =>
                                    router.push(matterDocumentsHref(projectId))
                                }
                                className="truncate text-[var(--app-text-muted)] transition-colors hover:text-[var(--app-text-strong)]"
                            >
                                {project.name}
                                {project.cm_number && (
                                    <span className="ml-1 text-[var(--app-text-subtle)]">
                                        (#{project.cm_number})
                                    </span>
                                )}
                            </button>
                        ) : (
                            <div className="h-6 w-32 animate-pulse rounded bg-[var(--app-active)]" />
                        )}
                        <span className="text-[var(--app-text-subtle)]">›</span>
                        <span className="text-[var(--app-text-strong)]">
                            Draft
                        </span>
                    </div>
                </div>
                {canMutate ? <button
                    type="button"
                    onClick={() => setDraftOpen(true)}
                    className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-[var(--app-text-strong)] px-4 py-2 text-sm font-medium text-[var(--app-shell)] transition-colors hover:opacity-90"
                >
                    <PenLine className="h-4 w-4" />
                    New draft
                </button> : null}
            </div>

            <div className="shrink-0 bg-[var(--app-shell-subtle)] px-4 md:px-8">
                <MatterNav projectId={projectId} active="authoring" variant="dark" />
            </div>

            {/* Body: center viewer + QA side-rail */}
            <div className="flex min-h-0 flex-1 overflow-hidden border-t border-[var(--app-border)]">
                {/* CENTER: produced draft viewer */}
                <div className="flex min-w-0 flex-1 flex-col border-r border-[var(--app-border)] bg-[var(--app-panel-soft)]">
                    {viewerDoc ? (
                        <>
                            {/* Draft toolbar */}
                            <div className="flex h-10 min-w-0 shrink-0 items-center border-b border-[var(--app-border)]">
                                <div className="flex min-w-0 flex-1 items-center gap-2 px-4">
                                    <PenLine className="h-3.5 w-3.5 shrink-0 text-[var(--app-text-subtle)]" />
                                    <span className="truncate text-xs font-medium text-[var(--app-text-strong)]">
                                        {viewerDoc.filename}
                                    </span>
                                </div>
                                {canExport ? <button
                                    type="button"
                                    onClick={() => void handleExport()}
                                    title="Export draft"
                                    className="flex shrink-0 items-center gap-1.5 border-l border-[var(--app-border)] px-3 text-xs font-medium text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                                >
                                    <Download className="h-3.5 w-3.5" />
                                    Export
                                </button> : null}
                                {canMutate ? <button
                                    type="button"
                                    onClick={() =>
                                        setSignFor({
                                            documentId: viewerDoc.documentId,
                                            filename: viewerDoc.filename,
                                        })
                                    }
                                    title="Send this draft for signature"
                                    className="flex shrink-0 items-center gap-1.5 border-l border-[var(--app-border)] px-3 text-xs font-medium text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                                >
                                    <FileSignature className="h-3.5 w-3.5" />
                                    Send for signature
                                </button> : null}
                            </div>
                            {/* Refine-in-Doc-Review hint */}
                            <div className="flex shrink-0 items-center gap-2 border-b border-[var(--app-border)] bg-[var(--app-panel)] px-4 py-2 text-[11px] text-[var(--app-text-muted)]">
                                <span>
                                    Saved to this matter. To redline or refine
                                    it, open it in
                                </span>
                                {canMutate ? <button
                                    type="button"
                                    onClick={() =>
                                        router.push(
                                            matterDocReviewHref(
                                                projectId,
                                                viewerDoc.documentId,
                                            ),
                                        )
                                    }
                                    className="font-medium text-[var(--app-accent)] underline-offset-2 hover:underline"
                                >
                                    Doc Review
                                </button> : (
                                    <p className="text-sm text-[var(--app-text-subtle)]">
                                        This workspace is read-only for your role.
                                    </p>
                                )}
                                <span>.</span>
                            </div>
                            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                                {isDocxFile(viewerDoc.filename) ? (
                                    <DocxView
                                        key={viewerDoc.documentId}
                                        documentId={viewerDoc.documentId}
                                        versionId={viewerDoc.versionId}
                                        rounded={false}
                                        bordered={false}
                                    />
                                ) : (
                                    <DocView
                                        key={viewerDoc.documentId}
                                        doc={{
                                            document_id: viewerDoc.documentId,
                                            version_id:
                                                viewerDoc.versionId ?? null,
                                        }}
                                        rounded={false}
                                        bordered={false}
                                    />
                                )}
                            </div>
                        </>
                    ) : (
                        // Empty state — nothing drafted yet.
                        <div className="flex h-full items-center justify-center bg-[var(--app-panel)] px-8">
                            <div className="max-w-md space-y-4 text-center">
                                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-[var(--app-border)] bg-[var(--app-shell-subtle)]">
                                    <PenLine className="h-5 w-5 text-[var(--app-text-muted)]" />
                                </div>
                                <p className="font-serif text-xl text-[var(--app-text)]">
                                    Draft a document to get started
                                </p>
                                <p className="font-serif text-base text-[var(--app-text-subtle)]">
                                    Pick a template, fill in the details, and
                                    Quill assembles a first draft scoped
                                    to this matter — with a four-guardrail QA
                                    pass.
                                </p>
                                <button
                                    type="button"
                                    onClick={() => setDraftOpen(true)}
                                    className="inline-flex items-center gap-2 rounded-lg bg-[var(--app-text-strong)] px-5 py-2.5 text-sm font-medium text-[var(--app-shell)] transition-colors hover:opacity-90"
                                >
                                    <PenLine className="h-4 w-4" />
                                    New draft
                                </button>
                            </div>
                        </div>
                    )}
                </div>

                {/* RIGHT: QA findings rail (shown once a draft with QA exists) */}
                {viewerDoc && hasQa && (
                    <div className="flex w-[340px] shrink-0 flex-col bg-[var(--app-panel)] p-3">
                        <DraftFindingsPanel
                            findings={qaFindings}
                            status={qaStatus ?? "passed"}
                            className="min-h-0 flex-1"
                        />
                    </div>
                )}
            </div>

            {/* Drafting wizard, scoped to this matter. */}
            {canMutate ? <NewDraftModal
                open={draftOpen}
                onClose={() => setDraftOpen(false)}
                projectId={projectId}
                onOpenDocument={(doc) =>
                    setViewerDoc({
                        documentId: doc.documentId,
                        versionId: doc.versionId ?? null,
                        filename: doc.filename,
                    })
                }
                onDrafted={(r) => {
                    setViewerDoc({
                        documentId: r.documentId,
                        versionId: r.versionId,
                        filename: r.filename,
                    });
                    setQaStatus(r.qaStatus ?? null);
                    setQaFindings(r.qaFindings ?? []);
                }}
            /> : null}

            {/* Reused "Send for signature" flow — identical prop contract to
                DocumentReviewWorkspace's mount. */}
            {signFor && (
                <SignersModal
                    open
                    onClose={() => setSignFor(null)}
                    documentId={signFor.documentId}
                    filename={signFor.filename}
                />
            )}
        </div>
    );
}
