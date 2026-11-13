"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PenLine } from "lucide-react";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { getGreetingName } from "@/lib/userIdentity";
import { CocoLegalIcon } from "@/components/chat/coco-legal-icon";
import { ChatInput } from "./ChatInput";
import { SelectAssistantProjectModal } from "./SelectAssistantProjectModal";
import { NewDraftModal } from "@/app/components/authoring/NewDraftModal";
import {
    OpenDraftInMatterModal,
    type OpenDraftDoc,
} from "./OpenDraftInMatterModal";
import { AppBackButton } from "@/app/components/shared/AppBackButton";
import { CocoCommandBackdrop } from "@/app/components/shared/CocoCommandBackdrop";
import type { CocoLegalMessage } from "../shared/types";

interface InitialViewProps {
    onSubmit: (message: CocoLegalMessage) => void;
    /** Commit a composer mic capture / audio upload — `useAssistantChat.commitRecording`. */
    onRecordAudio?: (input: {
        blob: Blob;
        filename: string;
        source: "mic" | "upload";
        durationSeconds?: number;
    }) => Promise<void>;
}

const ICON_SIZE = 35;
const GAP = 16; // gap-4 = 1rem = 16px

export function InitialView({ onSubmit, onRecordAudio }: InitialViewProps) {
    const { profile } = useUserProfile();
    const [loaded, setLoaded] = useState(false);
    const [projectModalOpen, setProjectModalOpen] = useState(false);
    const [draftModalOpen, setDraftModalOpen] = useState(false);
    // The draft awaiting "Open document" → file-into-matter (see below).
    const [pendingOpen, setPendingOpen] = useState<OpenDraftDoc | null>(null);
    const [iconOffset, setIconOffset] = useState(0);
    const [textOffset, setTextOffset] = useState(0);
    const textRef = useRef<HTMLHeadingElement>(null);

    const greetingName = getGreetingName(profile?.displayName);

    useLayoutEffect(() => {
        if (!textRef.current) return;
        const h1Width = textRef.current.offsetWidth;
        setIconOffset((h1Width + GAP) / 2);
        setTextOffset((ICON_SIZE + GAP) / 2);
    }, [greetingName]);

    useEffect(() => {
        if (!iconOffset) return;
        const t = setTimeout(() => setLoaded(true), 100);
        return () => clearTimeout(t);
    }, [iconOffset]);

    return (
        <div className="relative flex h-full w-full overflow-hidden bg-[var(--app-shell)] px-6 text-[var(--app-text)]">
            <CocoCommandBackdrop variant="hero" />
            <AppBackButton
                variant="dark"
                className="absolute left-4 top-4 z-20 md:left-6 md:top-6"
            />

            <div className="relative z-10 flex flex-1 flex-col items-center justify-center">
                <div className="flex-col items-center w-full max-w-4xl relative px-0 xl:px-8">
                    <div className="mb-5 relative flex h-[52px] items-center justify-center">
                        <div
                            className="absolute h-[35px]"
                            style={{
                                left: "50%",
                                transform: loaded
                                    ? `translateX(calc(-50% - ${iconOffset}px))`
                                    : "translateX(-50%)",
                                transition:
                                    "transform 900ms cubic-bezier(0.25, 0.46, 0.45, 0.94)",
                            }}
                        >
                            <CocoLegalIcon
                                size={ICON_SIZE}
                                style={{
                                    filter:
                                        "drop-shadow(0 0 18px rgba(251, 191, 36, 0.22)) brightness(1.75)",
                                }}
                            />
                        </div>
                        <h1
                            ref={textRef}
                            className="absolute max-w-[calc(100vw-3rem)] truncate text-center text-4xl font-serif font-light text-[var(--app-text-strong)] drop-shadow-[0_10px_30px_rgba(15,23,42,0.16)] whitespace-nowrap md:text-5xl"
                            style={{
                                left: "50%",
                                transform: loaded
                                    ? `translateX(calc(-50% + ${textOffset}px))`
                                    : "translateX(-50%)",
                                opacity: loaded ? 1 : 0,
                                transition:
                                    "transform 900ms cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 800ms ease-in-out 300ms",
                            }}
                        >
                            Hi, {greetingName}
                        </h1>
                    </div>
                    <p className="mx-auto mb-7 max-w-2xl text-center text-sm font-medium leading-6 text-[var(--app-text-muted)] md:text-base">
                        Quill — contract intelligence, matter strategy,
                        and AI legal operations.
                    </p>

                    <ChatInput
                        onSubmit={onSubmit}
                        onCancel={() => {}}
                        isLoading={false}
                        onProjectsClick={() => setProjectModalOpen(true)}
                        variant="command"
                        onRecordAudio={onRecordAudio}
                    />

                    <div className="mt-4 flex justify-center">
                        <button
                            type="button"
                            onClick={() => setDraftModalOpen(true)}
                            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-command-muted)] px-4 py-2 text-sm font-medium text-[var(--app-text-muted)] backdrop-blur-sm transition-colors hover:bg-[var(--app-command)] hover:text-[var(--app-text-strong)]"
                        >
                            <PenLine className="h-3.5 w-3.5" />
                            Draft a document
                        </button>
                    </div>

                    <div className="text-center">
                        <p className="text-xs py-3 mb-3 text-[var(--app-text-subtle)]">
                            AI can make mistakes. Answers are not legal advice.
                        </p>
                    </div>
                </div>
            </div>

            <SelectAssistantProjectModal
                open={projectModalOpen}
                onClose={() => setProjectModalOpen(false)}
            />

            {/* Standalone (no-project) drafting. The draft is a real document
                but has no matter yet, and Doc Review is matter-scoped — so
                "Open document" files it into a matter (picked/created in
                OpenDraftInMatterModal) and then opens it in Doc Review. */}
            <NewDraftModal
                open={draftModalOpen}
                onClose={() => setDraftModalOpen(false)}
                onOpenDocument={(d) =>
                    setPendingOpen({
                        documentId: d.documentId,
                        versionId: d.versionId,
                        filename: d.filename,
                    })
                }
            />

            <OpenDraftInMatterModal
                open={!!pendingOpen}
                doc={pendingOpen}
                onClose={() => setPendingOpen(null)}
            />
        </div>
    );
}
