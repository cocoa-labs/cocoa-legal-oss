"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { PanelLeft } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { ChatHistoryProvider } from "@/app/contexts/ChatHistoryContext";
import { NavigationHistoryProvider } from "@/app/contexts/NavigationHistoryContext";
import { SidebarContext } from "@/app/contexts/SidebarContext";
import { AppSidebar } from "@/app/components/shared/AppSidebar";
import { SignatureSummaryProvider } from "@/app/components/legal/SignatureSummaryContext";

export default function CocoaLegalLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const { isAuthenticated, authLoading } = useAuth();
    const router = useRouter();

    const [isSidebarOpenDesktop, setIsSidebarOpenDesktop] = useState(() => {
        if (typeof window !== "undefined") {
            const saved = localStorage.getItem("sidebarOpen");
            return saved !== null ? saved === "true" : true;
        }
        return true;
    });

    const [isSidebarOpen, setIsSidebarOpen] = useState(() => {
        if (typeof window !== "undefined" && window.innerWidth < 768) {
            return false;
        }
        return true;
    });

    useEffect(() => {
        if (typeof window !== "undefined" && window.innerWidth >= 768) {
            localStorage.setItem("sidebarOpen", isSidebarOpenDesktop.toString());
        }
    }, [isSidebarOpenDesktop]);

    useEffect(() => {
        if (typeof window === "undefined") return;
        const handleResize = () => {
            const isSmall = window.innerWidth < 768;
            if (isSmall && isSidebarOpen) setIsSidebarOpen(false);
            else if (!isSmall && !isSidebarOpen)
                setIsSidebarOpen(isSidebarOpenDesktop);
        };
        window.addEventListener("resize", handleResize);
        return () => window.removeEventListener("resize", handleResize);
    }, [isSidebarOpen, isSidebarOpenDesktop]);

    const handleSidebarToggle = () => {
        if (window.innerWidth >= 768) {
            setIsSidebarOpenDesktop(!isSidebarOpenDesktop);
            setIsSidebarOpen(!isSidebarOpenDesktop);
        } else {
            setIsSidebarOpen(!isSidebarOpen);
        }
    };

    useEffect(() => {
        if (!authLoading && !isAuthenticated) {
            router.push("/login");
        }
    }, [authLoading, isAuthenticated, router]);

    if (authLoading) {
        return (
            <div className="flex h-screen items-center justify-center">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-gray-700" />
            </div>
        );
    }

    if (!isAuthenticated) return null;

    return (
        <ChatHistoryProvider>
            <NavigationHistoryProvider>
                <SignatureSummaryProvider>
                <SidebarContext.Provider
                    value={{
                        setSidebarOpen: (open) => {
                            setIsSidebarOpen(open);
                            setIsSidebarOpenDesktop(open);
                        },
                    }}
                >
                    <div className="h-dvh bg-[var(--app-shell)] flex flex-col">
                        <div className="flex-1 flex overflow-hidden">
                            <AppSidebar
                                isOpen={isSidebarOpen}
                                onToggle={handleSidebarToggle}
                            />
                            <div className="flex-1 flex flex-col h-dvh md:overflow-hidden relative w-full">
                                {/* Mobile header */}
                                <div className="flex md:hidden items-center gap-3 px-4 pt-3 pb-1 shrink-0">
                                    <button
                                        onClick={handleSidebarToggle}
                                        className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--app-command)] text-[var(--app-text-muted)] shadow-[var(--app-elevated-shadow)] ring-1 ring-[var(--app-border)] backdrop-blur-md transition-all hover:bg-[var(--app-panel)] hover:text-[var(--app-text-strong)] active:scale-95"
                                        title="Open sidebar"
                                        aria-label="Open sidebar"
                                    >
                                        <PanelLeft className="h-4 w-4" />
                                    </button>
                                </div>
                                <main className="flex-1 overflow-y-auto md:overflow-hidden w-full h-full">
                                    {children}
                                </main>
                            </div>
                        </div>
                    </div>
                </SidebarContext.Provider>
                </SignatureSummaryProvider>
            </NavigationHistoryProvider>
        </ChatHistoryProvider>
    );
}
