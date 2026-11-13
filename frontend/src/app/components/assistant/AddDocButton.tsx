"use client";

import { useRef, useState } from "react";
import { PlusIcon, Upload, LayoutGridIcon, Loader2Icon } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { uploadStandaloneDocument } from "@/app/lib/cocoLegalApi";
import { cn } from "@/lib/utils";
import type { CocoLegalDocument } from "../shared/types";
import { DOCUMENT_ACCEPT_ATTR } from "@/app/lib/uploadTypes";

interface Props {
    onSelectDoc: (doc: CocoLegalDocument) => void;
    onBrowseAll: () => void;
    selectedDocIds?: string[];
    variant?: "default" | "command";
}

export function AddDocButton({
    onSelectDoc,
    onBrowseAll,
    selectedDocIds = [],
    variant = "default",
}: Props) {
    const [isOpen, setIsOpen] = useState(false);
    const [uploading, setUploading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const isCommand = variant === "command";

    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;
        setUploading(true);
        try {
            const uploaded = await Promise.all(
                files.map((f) => uploadStandaloneDocument(f)),
            );
            uploaded.forEach((doc) => onSelectDoc(doc));
        } catch (err) {
            console.error("Upload failed:", err);
        } finally {
            setUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    };

    return (
        <>
            <input
                ref={fileInputRef}
                type="file"
                accept={DOCUMENT_ACCEPT_ATTR}
                multiple
                className="hidden"
                onChange={handleUpload}
            />
            <DropdownMenu onOpenChange={setIsOpen}>
                <DropdownMenuTrigger asChild>
                    <button
                        className={cn(
                            "flex items-center gap-1 px-2 h-8 rounded-lg text-sm transition-colors cursor-pointer",
                            selectedDocIds.length > 0
                                ? isCommand
                                    ? "text-[var(--app-warm)] hover:bg-[var(--app-hover)]"
                                    : "text-black hover:bg-gray-100"
                                : isCommand
                                  ? "text-[var(--app-text-muted)] hover:text-[var(--app-text-strong)] hover:bg-[var(--app-hover)]"
                                  : "text-gray-400 hover:text-gray-700 hover:bg-gray-100",
                            isOpen &&
                                (isCommand
                                    ? "bg-[var(--app-active)] text-[var(--app-text-strong)]"
                                    : "bg-gray-100"),
                        )}
                        title="Add documents"
                        aria-label="Add documents"
                    >
                        {selectedDocIds.length > 0 ? (
                            <span className="font-medium tabular-nums">
                                {selectedDocIds.length}
                            </span>
                        ) : (
                            <PlusIcon
                                className={`h-4 w-4 shrink-0 transition-transform duration-300 ${isOpen ? "rotate-[135deg]" : ""}`}
                            />
                        )}
                        <span className="hidden sm:inline">
                            {selectedDocIds.length === 1
                                ? "Document"
                                : "Documents"}
                        </span>
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                    className="w-44 z-50"
                    side="bottom"
                    align="start"
                >
                    <DropdownMenuItem
                        className="cursor-pointer"
                        disabled={uploading}
                        onSelect={(e) => {
                            e.preventDefault();
                            fileInputRef.current?.click();
                        }}
                    >
                        {uploading ? (
                            <Loader2Icon className="h-4 w-4 mr-2 animate-spin text-gray-400" />
                        ) : (
                            <Upload className="h-4 w-4 mr-2 text-gray-500" />
                        )}
                        <span className="text-sm">
                            {uploading ? "Uploading…" : "Upload files"}
                        </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        className="cursor-pointer"
                        onClick={onBrowseAll}
                    >
                        <LayoutGridIcon className="h-4 w-4 mr-2 text-gray-500" />
                        <span className="text-sm">Browse all</span>
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </>
    );
}
