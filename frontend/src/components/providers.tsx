"use client";

import { AuthProvider } from "@/contexts/AuthContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { UserProfileProvider } from "@/contexts/UserProfileContext";
import { AppVersionGuard } from "@/components/AppVersionGuard";

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <ThemeProvider>
            <AppVersionGuard>
                <AuthProvider>
                    <UserProfileProvider>{children}</UserProfileProvider>
                </AuthProvider>
            </AppVersionGuard>
        </ThemeProvider>
    );
}
