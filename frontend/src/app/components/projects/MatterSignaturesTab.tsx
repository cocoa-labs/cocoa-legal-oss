"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getProject } from "@/app/lib/cocoaLegalApi";
import { AppBackButton } from "@/app/components/shared/AppBackButton";
import { MatterNav } from "./MatterNav";
import { SignaturesPanel } from "@/app/components/legal/SignaturesPanel";

/**
 * Per-matter Signatures tab. Renders the standard matter chrome (back button,
 * breadcrumb, MatterNav with "Signatures" active) and the SignaturesPanel
 * scoped to this matter. Routed at /projects/[id]/signatures, mirroring how the
 * Command tab (/workspace) is its own route.
 */
export function MatterSignaturesTab({ projectId }: { projectId: string }) {
    const router = useRouter();
    const [matterName, setMatterName] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        getProject(projectId)
            .then((proj) => {
                if (!cancelled) setMatterName(proj.name);
            })
            .catch(() => {
                if (!cancelled) setMatterName(null);
            });
        return () => {
            cancelled = true;
        };
    }, [projectId]);

    return (
        <div className="flex h-full flex-col overflow-y-auto bg-white">
            <div className="flex items-center gap-2 px-4 py-3 md:px-10">
                <AppBackButton variant="light" />
                <div className="flex min-w-0 items-center gap-2 text-xs text-gray-500">
                    <Link href="/projects" className="hover:text-gray-900">
                        Matters
                    </Link>
                    <span>/</span>
                    <button
                        type="button"
                        onClick={() => router.push(`/projects/${projectId}`)}
                        className="truncate font-medium text-gray-700 hover:text-gray-900"
                    >
                        {matterName ?? "Matter"}
                    </button>
                </div>
            </div>

            <MatterNav projectId={projectId} active="signatures" />

            <div className="min-h-0 flex-1 px-4 py-5 md:px-10">
                <SignaturesPanel projectId={projectId} />
            </div>
        </div>
    );
}
