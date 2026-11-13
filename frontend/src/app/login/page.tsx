"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import Link from "next/link";
import { useAuth } from "@/contexts/AuthContext";
import { AuthShell } from "@/app/components/auth/AuthShell";
export default function LoginPage() {
    const router = useRouter();
    const { isAuthenticated, authLoading } = useAuth();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!authLoading && isAuthenticated) {
            router.replace("/assistant");
        }
    }, [authLoading, isAuthenticated, router]);

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        try {
            const { error } = await supabase.auth.signInWithPassword({
                email,
                password,
            });

            if (error) throw error;

            router.push("/assistant");
        } catch (error: unknown) {
            setError(
                error instanceof Error
                    ? error.message
                    : "An error occurred during login",
            );
        } finally {
            setLoading(false);
        }
    };

    return (
        <AuthShell>
            <div>
                <div className="mb-4 rounded-[14px] border border-[var(--app-border)] bg-[var(--app-command)] p-8 shadow-[var(--app-command-shadow)] backdrop-blur-xl">
                    <div className="flex justify-between items-center mb-6">
                        <h2 className="text-left text-3xl font-serif font-light text-[var(--app-text-strong)]">
                            Log In
                        </h2>
                        <div className="bg-[var(--app-command-muted)] p-1 rounded-md flex text-xs font-medium ring-1 ring-[var(--app-border)]">
                            <span className="text-[var(--app-text-strong)] px-3 py-1 bg-[var(--app-active)] rounded-sm shadow-sm">
                                Log in
                            </span>
                            <Link
                                href="/signup"
                                className="px-3 py-1 text-[var(--app-text-muted)] hover:text-[var(--app-text-strong)]"
                            >
                                Sign up
                            </Link>
                        </div>
                    </div>
                    <form onSubmit={handleLogin} className="space-y-4">
                        <div>
                            <label
                                htmlFor="email"
                                className="block text-sm font-medium text-[var(--app-text-muted)] mb-2"
                            >
                                Email
                            </label>
                            <Input
                                id="email"
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                placeholder="Enter your email"
                                required
                                className="w-full border-[var(--app-border)] bg-[var(--app-command-input)] text-[var(--app-text-strong)] shadow-none placeholder:text-[var(--app-text-subtle)] focus-visible:ring-[var(--app-warm)]"
                            />
                        </div>

                        <div>
                            <label
                                htmlFor="password"
                                className="block text-sm font-medium text-[var(--app-text-muted)] mb-2"
                            >
                                Password
                            </label>
                            <Input
                                id="password"
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="Enter your password"
                                required
                                className="w-full border-[var(--app-border)] bg-[var(--app-command-input)] text-[var(--app-text-strong)] shadow-none placeholder:text-[var(--app-text-subtle)] focus-visible:ring-[var(--app-warm)]"
                            />
                        </div>

                        {error && (
                            <div className="text-red-200 text-sm bg-red-500/10 border border-red-300/20 p-3 rounded">
                                {error}
                            </div>
                        )}

                        <Button
                            type="submit"
                            disabled={loading}
                            className="w-full mt-5 bg-gradient-to-b from-amber-200 to-amber-500 text-black hover:from-amber-100 hover:to-amber-400"
                        >
                            {loading ? "Logging in..." : "Log in"}
                        </Button>
                    </form>
                </div>
                <p className="text-center text-xs text-[var(--app-text-subtle)] leading-relaxed px-2">
                    Coco Legal is currently a demo service. Please do not
                    upload, submit, or store sensitive, confidential,
                    privileged, client, or personally identifiable documents.
                </p>
            </div>
        </AuthShell>
    );
}
