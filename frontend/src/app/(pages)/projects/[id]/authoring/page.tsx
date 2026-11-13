"use client";

import { use } from "react";
import { AuthoringWorkspace } from "@/app/components/authoring/AuthoringWorkspace";

interface Props {
    params: Promise<{ id: string }>;
}

export default function ProjectAuthoringPage({ params }: Props) {
    const { id } = use(params);
    return <AuthoringWorkspace projectId={id} />;
}
