"use client";

import { use } from "react";
import { DocumentReviewWorkspace } from "@/app/components/doc-review/DocumentReviewWorkspace";

interface Props {
    params: Promise<{ id: string }>;
}

export default function ProjectDocReviewPage({ params }: Props) {
    const { id } = use(params);
    return <DocumentReviewWorkspace projectId={id} />;
}
