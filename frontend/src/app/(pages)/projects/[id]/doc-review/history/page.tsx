"use client";

import { use } from "react";
import { DocumentHistoryGraph } from "@/app/components/doc-review/DocumentHistoryGraph";

interface Props {
    params: Promise<{ id: string }>;
}

export default function ProjectDocHistoryPage({ params }: Props) {
    const { id } = use(params);
    return <DocumentHistoryGraph projectId={id} />;
}
