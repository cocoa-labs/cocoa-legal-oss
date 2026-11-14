"use client";

import {
    useState,
    useCallback,
    useEffect,
    useRef,
    forwardRef,
    useImperativeHandle,
} from "react";
import { usePathname } from "next/navigation";
import {
    AlertCircle,
    ArrowRight,
    Check,
    FileText,
    FolderOpen,
    Image as ImageIcon,
    Library,
    Loader2,
    Paperclip,
    Square,
    X,
} from "lucide-react";
import { AssistantWorkflowModal } from "./AssistantWorkflowModal";
import { ApiKeyMissingModal } from "../shared/ApiKeyMissingModal";
import { ModelToggle } from "./ModelToggle";
import { useSelectedModel } from "@/app/hooks/useSelectedModel";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { cn } from "@/lib/utils";
import {
    getFirstAvailableModel,
    getModelProvider,
    isModelAvailable,
    isModelVisionCapable,
    type ModelProvider,
} from "@/app/lib/modelAvailability";
import {
    uploadChatImageAttachment,
    uploadProjectDocument,
    uploadStandaloneDocument,
} from "@/app/lib/cocoaLegalApi";
import { invalidateDirectoryCache } from "../shared/useDirectoryData";
import {
    RecorderControl,
    type RecorderCompleteResult,
} from "../recordings/RecorderControl";
import { ConsentConfirm } from "../recordings/ConsentConfirm";
import type {
    CocoaLegalDocument,
    CocoaLegalImageAttachment,
    CocoaLegalMessage,
    CocoaLegalMessageAttachment,
} from "../shared/types";
import { useAppVersionReloadBlocker } from "@/components/AppVersionGuard";
import {
    composerDraftStorageKey,
    persistComposerDraft,
    readComposerDraft,
} from "@/app/lib/appVersionState";

export interface ChatInputHandle {
    addDoc: (doc: CocoaLegalDocument) => void;
}

interface Props {
    onSubmit: (message: CocoaLegalMessage) => void;
    onCancel: () => void;
    isLoading: boolean;
    hideAddDocButton?: boolean;
    hideWorkflowButton?: boolean;
    onProjectsClick?: () => void;
    projectId?: string;
    projectName?: string;
    projectCmNumber?: string | null;
    onDocumentsUploaded?: (documents: CocoaLegalDocument[]) => void;
    variant?: "default" | "command";
    /**
     * Commit a mic capture / audio upload into the conversation (locked
     * recordings UX: no composer chip, no user-message ref — the backend inserts
     * a durable card and the message list refreshes). Wired from
     * `useAssistantChat.commitRecording`. When omitted, the mic and audio-file
     * routing are disabled and audio files fall back to the unsupported path.
     */
    onRecordAudio?: (input: {
        blob: Blob;
        filename: string;
        source: "mic" | "upload";
        durationSeconds?: number;
    }) => Promise<void>;
}

type AttachmentItem =
    | {
          localId: string;
          kind: "document";
          filename: string;
          document?: CocoaLegalDocument;
          uploading: boolean;
          error?: string;
      }
    | {
          localId: string;
          kind: "image";
          filename: string;
          mimeType: CocoaLegalImageAttachment["mime_type"];
          sizeBytes: number;
          previewUrl: string;
          attachment?: CocoaLegalImageAttachment;
          uploading: boolean;
          error?: string;
      };

import {
    AUDIO_ACCEPT_ATTR,
    CHAT_ACCEPT_ATTR,
    DOCUMENT_EXTENSIONS_HUMAN,
    MAX_AUDIO_BYTES,
    MAX_IMAGE_BYTES,
    isAudioFile,
    isDocumentFile,
    isImageFile,
} from "@/app/lib/uploadTypes";

const DEFAULT_ATTACHMENT_PROMPT = "Review the attached file(s).";

function localId() {
    return (
        globalThis.crypto?.randomUUID?.() ??
        `attachment-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
}

function describeUploadError(error: unknown) {
    const raw = error instanceof Error ? error.message : String(error);
    try {
        const parsed = JSON.parse(raw) as { detail?: unknown };
        if (typeof parsed.detail === "string") return parsed.detail;
    } catch {
        // Keep the original message below.
    }
    return raw || "Upload failed.";
}

export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput(
    {
        onSubmit,
        onCancel,
        isLoading,
        hideWorkflowButton,
        onProjectsClick,
        projectId,
        projectName,
        projectCmNumber,
        onDocumentsUploaded,
        variant = "default",
        onRecordAudio,
    }: Props,
    ref,
) {
    const pathname = usePathname();
    const draftStorageKey = composerDraftStorageKey(pathname);
    const [value, setValue] = useState("");
    const [restoredDraftKey, setRestoredDraftKey] = useState<string | null>(
        null,
    );
    const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
    const [selectedWorkflow, setSelectedWorkflow] = useState<{
        id: string;
        title: string;
    } | null>(null);
    const [model, setModel] = useSelectedModel();
    const { profile } = useUserProfile();
    const apiKeys = profile?.apiKeys;
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [workflowModalOpen, setWorkflowModalOpen] = useState(false);
    const [apiKeyModalProvider, setApiKeyModalProvider] =
        useState<ModelProvider | null>(null);
    const [attachmentError, setAttachmentError] = useState<string | null>(null);
    const [isDragOver, setIsDragOver] = useState(false);
    // An audio file picked/dropped/pasted, parked until the user acknowledges
    // consent inline. Nothing uploads until they confirm; cancel discards it.
    const [pendingAudio, setPendingAudio] = useState<File | null>(null);
    // True while an audio upload is being committed (mirrors RecorderControl's
    // own "Saving…" state, which covers the mic path).
    const [recordingBusy, setRecordingBusy] = useState(false);
    const attachmentsRef = useRef<AttachmentItem[]>([]);
    const isCommand = variant === "command";

    useEffect(() => {
        const saved = readComposerDraft(sessionStorage, draftStorageKey);
        setValue((current) => current || saved || "");
        setRestoredDraftKey(draftStorageKey);
    }, [draftStorageKey]);

    useEffect(() => {
        if (restoredDraftKey !== draftStorageKey) return;
        persistComposerDraft(sessionStorage, draftStorageKey, value);
    }, [draftStorageKey, restoredDraftKey, value]);

    useAppVersionReloadBlocker(value.trim().length > 0, "draft");
    useAppVersionReloadBlocker(
        isLoading ||
            attachments.length > 0 ||
            pendingAudio !== null ||
            recordingBusy ||
            selectedWorkflow !== null,
        "busy",
    );

    const updateAttachment = useCallback(
        (id: string, patch: Partial<AttachmentItem>) => {
            setAttachments((prev) =>
                prev.map((item) =>
                    item.localId === id
                        ? ({ ...item, ...patch } as AttachmentItem)
                        : item,
                ),
            );
        },
        [],
    );

    const revokePreview = useCallback((item: AttachmentItem) => {
        if (item.kind === "image") URL.revokeObjectURL(item.previewUrl);
    }, []);

    const removeAttachment = useCallback(
        (id: string) => {
            setAttachments((prev) => {
                const item = prev.find((entry) => entry.localId === id);
                if (item) revokePreview(item);
                return prev.filter((entry) => entry.localId !== id);
            });
        },
        [revokePreview],
    );

    useEffect(() => {
        attachmentsRef.current = attachments;
    }, [attachments]);

    useEffect(() => {
        return () => attachmentsRef.current.forEach(revokePreview);
    }, [revokePreview]);

    useImperativeHandle(ref, () => ({
        addDoc: (doc: CocoaLegalDocument) => {
            setAttachments((prev) => {
                if (
                    prev.some(
                        (item) =>
                            item.kind === "document" &&
                            item.document?.id === doc.id,
                    )
                ) {
                    return prev;
                }
                return [
                    ...prev,
                    {
                        localId: `doc-${doc.id}`,
                        kind: "document",
                        filename: doc.filename,
                        document: doc,
                        uploading: false,
                    },
                ];
            });
        },
    }));

    useEffect(() => {
        if (!apiKeys || isModelAvailable(model, apiKeys)) return;
        const availableModel = getFirstAvailableModel(apiKeys);
        if (availableModel && availableModel !== model) {
            setModel(availableModel);
        }
    }, [apiKeys, model, setModel]);

    const handleFiles = useCallback(
        async (incomingFiles: File[]) => {
            const files = incomingFiles.filter((file) => file.size > 0);
            if (!files.length) return;

            // Accumulate errors across the batch so distinct categories
            // (unsupported type + oversized image) both surface — the
            // old code overwrote the prior message on each error.
            const errors: string[] = [];

            // Route audio into the recordings flow (only where recording is
            // wired). isAudioFile matches by extension OR MIME, so a picked
            // .m4a and a pasted audio/webm blob both qualify. The first valid
            // audio file is parked for inline consent — nothing uploads until
            // the user confirms; the rest of the batch (docs/images) still
            // flows through the normal attachment path below.
            const audioFiles = onRecordAudio ? files.filter(isAudioFile) : [];
            const rest = onRecordAudio
                ? files.filter((file) => !isAudioFile(file))
                : files;

            if (audioFiles.length > 0) {
                const audio = audioFiles[0];
                if (audio.size > MAX_AUDIO_BYTES) {
                    errors.push(
                        `Audio file skipped — over ${Math.round(
                            MAX_AUDIO_BYTES / (1024 * 1024),
                        )} MB.`,
                    );
                } else {
                    setPendingAudio(audio);
                }
                if (audioFiles.length > 1) {
                    errors.push(
                        "Only one recording can be added at a time — extra audio files were skipped.",
                    );
                }
            }

            if (!rest.length) {
                setAttachmentError(errors.length ? errors.join(" ") : null);
                if (fileInputRef.current) fileInputRef.current.value = "";
                return;
            }

            const unsupported = rest.filter(
                (file) => !isDocumentFile(file) && !isImageFile(file),
            );
            if (unsupported.length) {
                errors.push(
                    `${unsupported.length} unsupported file${unsupported.length === 1 ? "" : "s"} skipped. Documents accepted: ${DOCUMENT_EXTENSIONS_HUMAN}. Images: PNG, JPEG, WebP, GIF.`,
                );
            }

            const valid = rest.filter(
                (file) => isDocumentFile(file) || isImageFile(file),
            );
            if (!valid.length) {
                setAttachmentError(errors.length ? errors.join(" ") : null);
                if (fileInputRef.current) fileInputRef.current.value = "";
                return;
            }

            let oversizedImageCount = 0;
            for (const file of valid) {
                if (isImageFile(file) && file.size > MAX_IMAGE_BYTES) {
                    oversizedImageCount++;
                    continue;
                }

                const id = localId();
                if (isImageFile(file)) {
                    const previewUrl = URL.createObjectURL(file);
                    const item: AttachmentItem = {
                        localId: id,
                        kind: "image",
                        filename: file.name,
                        mimeType:
                            file.type as CocoaLegalImageAttachment["mime_type"],
                        sizeBytes: file.size,
                        previewUrl,
                        uploading: true,
                    };
                    setAttachments((prev) => [...prev, item]);
                    uploadChatImageAttachment(file, { projectId })
                        .then((attachment) => {
                            updateAttachment(id, {
                                filename: attachment.filename,
                                attachment,
                                uploading: false,
                            });
                        })
                        .catch((error) => {
                            updateAttachment(id, {
                                uploading: false,
                                error: describeUploadError(error),
                            });
                        });
                    continue;
                }

                const item: AttachmentItem = {
                    localId: id,
                    kind: "document",
                    filename: file.name,
                    uploading: true,
                };
                setAttachments((prev) => [...prev, item]);
                const upload = projectId
                    ? uploadProjectDocument(projectId, file)
                    : uploadStandaloneDocument(file);
                upload
                    .then((document) => {
                        invalidateDirectoryCache();
                        onDocumentsUploaded?.([document]);
                        updateAttachment(id, {
                            filename: document.filename,
                            document,
                            uploading: false,
                        });
                    })
                    .catch((error) => {
                        updateAttachment(id, {
                            uploading: false,
                            error: describeUploadError(error),
                        });
                    });
            }

            if (oversizedImageCount > 0) {
                errors.push(
                    `${oversizedImageCount} image${oversizedImageCount === 1 ? "" : "s"} skipped — over 20 MB.`,
                );
            }
            setAttachmentError(errors.length ? errors.join(" ") : null);

            if (fileInputRef.current) fileInputRef.current.value = "";
        },
        [onDocumentsUploaded, projectId, updateAttachment, onRecordAudio],
    );

    // Commit a finished mic capture. RecorderControl awaits this (showing
    // "Saving…"), and rejections surface via the composer error affordance —
    // T11 flagged that onComplete rejections were otherwise unhandled.
    const handleRecorderComplete = useCallback(
        async (result: RecorderCompleteResult) => {
            if (!onRecordAudio) return;
            try {
                await onRecordAudio({
                    blob: result.blob,
                    filename: result.suggestedFilename,
                    source: "mic",
                    durationSeconds: Math.round(result.durationMs / 1000),
                });
                setAttachmentError(null);
            } catch (error) {
                setAttachmentError(describeUploadError(error));
            }
        },
        [onRecordAudio],
    );

    // Consent confirmed for a parked audio upload → run the same commit path
    // with source "upload" and the file's real name.
    const handleAudioConsentConfirm = useCallback(async () => {
        if (!onRecordAudio || !pendingAudio) return;
        const file = pendingAudio;
        setPendingAudio(null);
        setRecordingBusy(true);
        try {
            await onRecordAudio({
                blob: file,
                filename: file.name,
                source: "upload",
            });
            setAttachmentError(null);
        } catch (error) {
            setAttachmentError(describeUploadError(error));
        } finally {
            setRecordingBusy(false);
        }
    }, [onRecordAudio, pendingAudio]);

    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setValue(e.target.value);
        const el = e.target;
        el.style.height = "auto";
        el.style.height = `${el.scrollHeight}px`;
    };

    const readyAttachments = attachments.filter(
        (item) => !item.uploading && !item.error,
    );
    const hasUploadingAttachments = attachments.some((item) => item.uploading);
    const hasImageAttachments = readyAttachments.some(
        (item) => item.kind === "image",
    );

    const handleSubmit = () => {
        const query = value.trim();
        if ((!query && readyAttachments.length === 0) || isLoading) return;
        if (hasUploadingAttachments) {
            setAttachmentError("Wait for uploads to finish before sending.");
            return;
        }
        if (apiKeys && !isModelAvailable(model, apiKeys)) {
            setApiKeyModalProvider(getModelProvider(model));
            return;
        }
        if (hasImageAttachments && !isModelVisionCapable(model)) {
            setAttachmentError(
                "The selected model cannot read images. Choose a vision-capable model or remove the image.",
            );
            return;
        }

        const files = readyAttachments
            .map((item): CocoaLegalMessageAttachment | null => {
                if (item.kind === "image") return item.attachment ?? null;
                if (!item.document) return null;
                return {
                    kind: "document",
                    filename: item.document.filename,
                    document_id: item.document.id,
                };
            })
            .filter((item): item is CocoaLegalMessageAttachment => !!item);

        setValue("");
        persistComposerDraft(sessionStorage, draftStorageKey, "");
        if (textareaRef.current) textareaRef.current.style.height = "auto";
        attachments.forEach(revokePreview);
        setAttachments([]);
        setAttachmentError(null);
        const wf = selectedWorkflow;
        setSelectedWorkflow(null);

        onSubmit?.({
            role: "user",
            content: query || DEFAULT_ATTACHMENT_PROMPT,
            files: files.length > 0 ? files : undefined,
            workflow: wf ?? undefined,
            model,
        });
    };

    const handleActionClick = () => {
        if (isLoading) {
            onCancel();
        } else {
            handleSubmit();
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    };

    const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
        const files = Array.from(e.dataTransfer.files ?? []);
        if (!files.length) return;
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(false);
        void handleFiles(files);
    };

    const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
        if (
            Array.from(e.dataTransfer.items ?? []).some(
                (item) => item.kind === "file",
            )
        ) {
            e.preventDefault();
            e.stopPropagation();
            setIsDragOver(true);
        }
    };

    const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
        const files = Array.from(e.clipboardData.files ?? []);
        if (!files.length) return;
        e.preventDefault();
        void handleFiles(files);
    };

    const canSend =
        isLoading ||
        ((!!value.trim() || readyAttachments.length > 0) &&
            !hasUploadingAttachments);

    return (
        <>
            <div className="w-full">
                <input
                    ref={fileInputRef}
                    type="file"
                    accept={
                        onRecordAudio
                            ? `${CHAT_ACCEPT_ATTR},${AUDIO_ACCEPT_ATTR}`
                            : CHAT_ACCEPT_ATTR
                    }
                    multiple
                    className="hidden"
                    onChange={(e) =>
                        void handleFiles(Array.from(e.target.files ?? []))
                    }
                />
                <div
                    onDrop={handleDrop}
                    onDragOver={handleDragOver}
                    onDragLeave={() => setIsDragOver(false)}
                    className={cn(
                        "rounded-[16px] md:rounded-[20px]",
                        isCommand
                            ? "border border-[var(--app-border-strong)] bg-[var(--app-command)] shadow-[var(--app-command-shadow)] backdrop-blur-xl"
                            : "border border-gray-300 bg-white",
                        isDragOver &&
                            "ring-2 ring-[var(--app-warm)] ring-offset-2 ring-offset-[var(--app-shell)]",
                    )}
                >
                    {(selectedWorkflow || attachments.length > 0) && (
                        <div className="flex flex-wrap gap-1.5 px-2 pt-2">
                            {selectedWorkflow && (
                                <div className="inline-flex items-center gap-1 rounded-full border border-white/20 bg-blue-600 py-0.5 pl-2.5 pr-1 text-xs text-white shadow backdrop-blur-sm">
                                    <Library className="h-2.5 w-2.5 shrink-0" />
                                    <span className="max-w-[140px] truncate">
                                        {selectedWorkflow.title}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            setSelectedWorkflow(null)
                                        }
                                        className="ml-0.5 rounded-full p-0.5 text-white/60 transition-colors hover:bg-white/20 hover:text-white"
                                    >
                                        <X className="h-2.5 w-2.5" />
                                    </button>
                                </div>
                            )}
                            {attachments.map((item) => (
                                <div
                                    key={item.localId}
                                    className={cn(
                                        "inline-flex max-w-[220px] items-center gap-1 rounded-full border py-0.5 pl-1 pr-1 text-xs shadow backdrop-blur-sm",
                                        item.error
                                            ? "border-red-500/30 bg-red-500/10 text-red-500"
                                            : isCommand
                                              ? "border-[var(--app-border)] bg-[var(--app-command-muted)] text-[var(--app-text-strong)]"
                                              : "border-gray-200 bg-gray-100 text-gray-800",
                                    )}
                                    title={item.error ?? item.filename}
                                >
                                    {item.kind === "image" ? (
                                        <span className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-black/10">
                                            {/* eslint-disable-next-line @next/next/no-img-element */}
                                            <img
                                                src={item.previewUrl}
                                                alt=""
                                                className="h-full w-full object-cover"
                                            />
                                        </span>
                                    ) : (
                                        <FileText className="ml-1 h-3 w-3 shrink-0 text-red-400" />
                                    )}
                                    {item.uploading && (
                                        <Loader2 className="h-3 w-3 shrink-0 animate-spin opacity-70" />
                                    )}
                                    {item.error && (
                                        <AlertCircle className="h-3 w-3 shrink-0" />
                                    )}
                                    <span className="truncate">
                                        {item.filename}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            removeAttachment(item.localId)
                                        }
                                        className={cn(
                                            "ml-0.5 rounded-full p-0.5 transition-colors",
                                            isCommand
                                                ? "text-[var(--app-text-subtle)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                                                : "text-gray-400 hover:bg-gray-200 hover:text-gray-700",
                                        )}
                                    >
                                        <X className="h-2.5 w-2.5" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}

                    {attachmentError && (
                        <div className="px-4 pt-2 text-xs text-red-500">
                            {attachmentError}
                        </div>
                    )}

                    {/* Parked audio upload — waits here for consent; nothing
                        uploads until Confirm, and Cancel discards the file. */}
                    {pendingAudio && (
                        <div className="px-3 pt-2">
                            <p
                                className="mb-1 truncate px-1 text-xs text-[var(--app-text-muted)]"
                                title={pendingAudio.name}
                            >
                                Add recording:{" "}
                                <span className="font-medium text-[var(--app-text-strong)]">
                                    {pendingAudio.name}
                                </span>
                            </p>
                            <ConsentConfirm
                                onConfirm={() =>
                                    void handleAudioConsentConfirm()
                                }
                                onCancel={() => setPendingAudio(null)}
                            />
                        </div>
                    )}

                    <div className="px-4 pt-4">
                        <textarea
                            ref={textareaRef}
                            rows={1}
                            placeholder="Ask Quill…"
                            value={value}
                            onChange={handleChange}
                            onKeyDown={handleKeyDown}
                            onPaste={handlePaste}
                            className={cn(
                                "max-h-48 w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-base leading-6 outline-none",
                                isCommand
                                    ? "text-[var(--app-text-strong)] placeholder:text-[var(--app-text-subtle)]"
                                    : "text-gray-900 placeholder:text-gray-400",
                            )}
                        />
                    </div>

                    <div className="flex items-center justify-between p-2 md:p-2.5">
                        <div className="flex items-center gap-1">
                            <button
                                type="button"
                                onClick={() => fileInputRef.current?.click()}
                                disabled={isLoading}
                                aria-label="Attach documents or images"
                                title="Attach documents or images"
                                className={cn(
                                    "flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm transition-colors disabled:opacity-50",
                                    attachments.length > 0
                                        ? isCommand
                                            ? "text-[var(--app-warm)] hover:bg-[var(--app-hover)]"
                                            : "text-black hover:bg-gray-100"
                                        : isCommand
                                          ? "text-[var(--app-text-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                                          : "text-gray-400 hover:bg-gray-100 hover:text-gray-700",
                                )}
                            >
                                {hasUploadingAttachments ? (
                                    <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                                ) : attachments.some(
                                      (item) => item.kind === "image",
                                  ) ? (
                                    <ImageIcon className="h-4 w-4 shrink-0" />
                                ) : (
                                    <Paperclip className="h-4 w-4 shrink-0" />
                                )}
                                <span className="hidden sm:inline">Attach</span>
                            </button>
                            {onRecordAudio && (
                                <RecorderControl
                                    variant="composer"
                                    onComplete={handleRecorderComplete}
                                    disabled={
                                        isLoading ||
                                        recordingBusy ||
                                        pendingAudio !== null
                                    }
                                />
                            )}
                            {!hideWorkflowButton && (
                                <button
                                    type="button"
                                    onClick={() => setWorkflowModalOpen(true)}
                                    aria-label="Open playbooks and workflows"
                                    className={cn(
                                        "flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm transition-colors",
                                        selectedWorkflow
                                            ? isCommand
                                                ? "text-[var(--app-warm)] hover:bg-[var(--app-hover)]"
                                                : "text-blue-600 hover:bg-blue-50"
                                            : isCommand
                                              ? "text-[var(--app-text-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                                              : "text-gray-400 hover:bg-gray-100 hover:text-gray-700",
                                    )}
                                >
                                    {selectedWorkflow ? (
                                        <Check className="h-3.5 w-3.5" />
                                    ) : (
                                        <Library className="h-3.5 w-3.5" />
                                    )}
                                    <span className="hidden sm:inline">
                                        Playbooks
                                    </span>
                                </button>
                            )}
                            {onProjectsClick && (
                                <button
                                    type="button"
                                    onClick={onProjectsClick}
                                    aria-label="Open matters"
                                    className={cn(
                                        "flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm transition-colors",
                                        isCommand
                                            ? "text-[var(--app-text-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                                            : "text-gray-400 hover:bg-gray-100 hover:text-gray-700",
                                    )}
                                >
                                    <FolderOpen className="h-3.5 w-3.5" />
                                    <span className="hidden sm:inline">
                                        Matters
                                    </span>
                                </button>
                            )}
                        </div>

                        <div className="flex items-center gap-1">
                            <ModelToggle
                                value={model}
                                onChange={setModel}
                                apiKeys={apiKeys}
                                variant={variant}
                            />
                            <button
                                type="button"
                                className="relative flex h-8 w-8 cursor-pointer items-center justify-center rounded-[10px] border border-white/30 bg-gradient-to-b from-neutral-700 to-black text-white backdrop-blur-xl transition-all duration-150 active:enabled:scale-95 disabled:cursor-default disabled:from-neutral-600 disabled:to-black"
                                onClick={handleActionClick}
                                disabled={!canSend}
                            >
                                {isLoading ? (
                                    <Square
                                        className="h-4 w-4"
                                        fill="currentColor"
                                        strokeWidth={0}
                                    />
                                ) : (
                                    <ArrowRight className="h-4 w-4" />
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <AssistantWorkflowModal
                open={workflowModalOpen}
                onClose={() => setWorkflowModalOpen(false)}
                onSelect={(wf) => {
                    setSelectedWorkflow({ id: wf.id, title: wf.title });
                    setWorkflowModalOpen(false);
                }}
                projectName={projectName}
                projectCmNumber={projectCmNumber}
            />
            <ApiKeyMissingModal
                open={apiKeyModalProvider !== null}
                provider={apiKeyModalProvider}
                onClose={() => setApiKeyModalProvider(null)}
            />
        </>
    );
});
