"use client";

import { use } from "react";
import { CocoaWorkspace } from "@/app/components/projects/CocoaWorkspace";

interface Props {
    params: Promise<{ id: string }>;
}

export default function ProjectWorkspacePage({ params }: Props) {
    const { id } = use(params);
    return <CocoaWorkspace projectId={id} />;
}
