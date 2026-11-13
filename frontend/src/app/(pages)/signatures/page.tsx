"use client";

import { SignaturesPanel } from "@/app/components/legal/SignaturesPanel";
import { AppBackButton } from "@/app/components/shared/AppBackButton";

export default function SignaturesPage() {
    return (
        <div className="relative h-full w-full overflow-hidden bg-[var(--app-shell)] px-6 py-6 text-[var(--app-text)]">
            <AppBackButton
                variant="dark"
                className="absolute left-4 top-4 z-20 md:left-6 md:top-6"
            />
            <div className="mx-auto flex h-full max-w-3xl flex-col pt-10">
                <SignaturesPanel />
            </div>
        </div>
    );
}
