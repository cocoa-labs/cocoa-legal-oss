"use client";

import { use } from "react";
import { DocumentReviewWorkspace } from "@/app/components/doc-review/DocumentReviewWorkspace";

interface Props {
    params: Promise<{ id: string; chatId: string }>;
}

export default function ProjectDocReviewChatPage({ params }: Props) {
    const { id, chatId } = use(params);
    return <DocumentReviewWorkspace projectId={id} chatId={chatId} />;
}
