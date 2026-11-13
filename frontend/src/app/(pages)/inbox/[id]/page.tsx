"use client";

import { useParams } from "next/navigation";
import { EmailThreadView } from "@/app/components/legal/EmailThreadView";
import { AppBackButton } from "@/app/components/shared/AppBackButton";

export default function InboxThreadPage() {
    const params = useParams();
    const id = params.id as string;
    return (
        <div className="relative h-full w-full overflow-hidden bg-[var(--app-shell)] px-6 py-6 text-[var(--app-text)]">
            <AppBackButton
                variant="dark"
                className="absolute left-4 top-4 z-20 md:left-6 md:top-6"
            />
            <div className="mx-auto flex h-full max-w-3xl flex-col pt-10">
                <EmailThreadView emailId={id} />
            </div>
        </div>
    );
}
