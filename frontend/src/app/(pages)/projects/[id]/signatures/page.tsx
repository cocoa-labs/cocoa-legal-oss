"use client";

import { use } from "react";
import { MatterSignaturesTab } from "@/app/components/projects/MatterSignaturesTab";

interface Props {
    params: Promise<{ id: string }>;
}

export default function ProjectSignaturesPage({ params }: Props) {
    const { id } = use(params);
    return <MatterSignaturesTab projectId={id} />;
}
