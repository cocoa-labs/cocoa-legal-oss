"use client";

import { SiteLogo } from "@/components/site-logo";
import { CocoCommandBackdrop } from "@/app/components/shared/CocoCommandBackdrop";

export function AuthShell({ children }: { children: React.ReactNode }) {
    return (
        <div className="relative min-h-dvh overflow-hidden bg-[var(--app-shell)] px-6 py-8 text-[var(--app-text)]">
            <CocoCommandBackdrop variant="auth" />

            <div className="relative z-10 mx-auto flex min-h-[calc(100dvh-4rem)] w-full max-w-6xl flex-col">
                <header className="flex items-center justify-between">
                    <SiteLogo
                        size="lg"
                        asLink
                        className="text-[var(--app-text-strong)] drop-shadow-[0_10px_30px_rgba(15,23,42,0.16)]"
                    />
                    <div className="hidden text-right text-[11px] font-medium uppercase tracking-[0.22em] text-[var(--app-warm)] md:block">
                        AI Legal Platform
                    </div>
                </header>

                <main className="grid flex-1 items-center gap-10 py-12 lg:grid-cols-[minmax(0,1fr)_460px]">
                    <section className="hidden max-w-xl lg:block">
                        <p className="mb-4 text-sm font-medium uppercase tracking-[0.24em] text-[var(--app-warm)]">
                            Coco Legal Suite
                        </p>
                        <h1 className="font-serif text-6xl font-light leading-[0.95] text-[var(--app-text-strong)]">
                            Contract intelligence for modern legal operations.
                        </h1>
                        <p className="mt-6 max-w-lg text-base leading-7 text-[var(--app-text-muted)]">
                            Matter strategy, deal-room analysis, litigation
                            workflows, and contract review inside one agentic
                            legal command center.
                        </p>
                        <div className="mt-8 grid max-w-lg grid-cols-2 gap-3 text-xs text-[var(--app-text-muted)]">
                            {[
                                "Clause risk analysis",
                                "Matter strategy",
                                "Review tables",
                                "Playbook automation",
                            ].map((item) => (
                                <div
                                    key={item}
                                    className="rounded-lg border border-[var(--app-border)] bg-[var(--app-command-muted)] px-3 py-2 backdrop-blur-sm"
                                >
                                    {item}
                                </div>
                            ))}
                        </div>
                    </section>

                    <div className="mx-auto w-full max-w-md lg:mx-0">
                        {children}
                    </div>
                </main>
            </div>
        </div>
    );
}
