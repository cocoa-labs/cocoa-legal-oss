"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { updateUserProfile } from "@/app/lib/cocoaLegalApi";
import { privacyUrl, termsUrl } from "@/app/lib/deploymentLinks";
import { MAX_DISPLAY_NAME_LENGTH } from "@/lib/userIdentity";
import { AuthShell } from "@/app/components/auth/AuthShell";

export default function SignupPage() {
    const router = useRouter();
    const { isAuthenticated, authLoading } = useAuth();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [name, setName] = useState("");
    const [organisation, setOrganisation] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState(false);

    useEffect(() => {
        if (!authLoading && isAuthenticated && !success) {
            router.replace("/assistant");
        }
    }, [authLoading, isAuthenticated, router, success]);

    const handleSignup = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        // Validate passwords match
        if (password !== confirmPassword) {
            setError("Passwords do not match");
            setLoading(false);
            return;
        }

        // Validate password length
        if (password.length < 6) {
            setError("Password must be at least 6 characters");
            setLoading(false);
            return;
        }

        try {
            const { data, error } = await supabase.auth.signUp({
                email,
                password,
            });

            if (error) throw error;

            if (data.session) {
                const trimmedName = name.trim();
                const trimmedOrg = organisation.trim();
                if (trimmedName || trimmedOrg) {
                    try {
                        await updateUserProfile({
                            ...(trimmedName && { displayName: trimmedName }),
                            ...(trimmedOrg && { organisation: trimmedOrg }),
                        });
                    } catch (profileError) {
                        console.error(
                            "[signup] failed to persist profile fields",
                            profileError,
                        );
                    }
                }
            }
            setSuccess(true);
            setTimeout(() => {
                router.push("/assistant");
            }, 2000);
        } catch (error: unknown) {
            const raw =
                error instanceof Error
                    ? error.message
                    : "An error occurred during signup";
            // Access is gated by an allowlist trigger on auth.users. Supabase
            // wraps that rejection as an opaque "Database error saving new
            // user", so translate it into something a real person can act on.
            const blocked =
                /database error saving new user|not permitted|approved addresses/i.test(
                    raw,
                );
            setError(
                blocked
                    ? "This email isn't on the approved list for Cocoa Legal. Ask your administrator to add it, then try again."
                    : raw,
            );
        } finally {
            setLoading(false);
        }
    };

    // Success View
    if (success) {
        return (
            <AuthShell>
                <div className="w-full max-w-md">
                    <div className="rounded-[14px] border border-[var(--app-border)] bg-[var(--app-command)] p-10 text-center shadow-[var(--app-command-shadow)] backdrop-blur-xl">
                        <div className="mx-auto w-12 h-12 bg-green-400/10 rounded-full flex items-center justify-center mb-6 ring-1 ring-green-300/25">
                            <CheckCircle2 className="h-6 w-6 text-green-200" />
                        </div>
                        <h2 className="text-2xl font-semibold text-[var(--app-text-strong)] mb-3">
                            Account created!
                        </h2>
                        <p className="text-[var(--app-text-muted)] leading-relaxed">
                            Redirecting you to the home page...
                        </p>
                    </div>
                </div>
            </AuthShell>
        );
    }

    // Default Signup Form View
    return (
        <AuthShell>
            <div className="w-full max-w-md">
                <div className="rounded-[14px] border border-[var(--app-border)] bg-[var(--app-command)] p-8 mb-4 shadow-[var(--app-command-shadow)] backdrop-blur-xl">
                    <div className="flex justify-between items-center mb-6">
                        <h2 className="text-left text-3xl font-serif font-light text-[var(--app-text-strong)]">
                            Create Account
                        </h2>
                        <div className="bg-[var(--app-command-muted)] p-1 rounded-md flex text-xs font-medium ring-1 ring-[var(--app-border)]">
                            <Link
                                href="/login"
                                className="px-3 py-1 text-[var(--app-text-muted)] hover:text-[var(--app-text-strong)]"
                            >
                                Log in
                            </Link>
                            <span className="px-3 py-1 bg-[var(--app-active)] rounded-sm shadow-sm text-[var(--app-text-strong)]">
                                Sign up
                            </span>
                        </div>
                    </div>

                    <p className="mb-5 text-sm text-[var(--app-text-muted)] leading-relaxed">
                        Access is limited to approved addresses. Use the work
                        email your administrator added, and choose any password
                        you like — you&apos;re setting it now.
                    </p>

                    <form onSubmit={handleSignup} className="space-y-4">
                        <div>
                            <label
                                htmlFor="name"
                                className="block text-sm font-medium text-[var(--app-text-muted)] mb-2"
                            >
                                Name{" "}
                                <span className="text-[var(--app-text-subtle)] font-normal">
                                    (optional)
                                </span>
                            </label>
                            <Input
                                id="name"
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="Your name"
                                maxLength={MAX_DISPLAY_NAME_LENGTH}
                                className="w-full border-[var(--app-border)] bg-[var(--app-command-input)] text-[var(--app-text-strong)] shadow-none placeholder:text-[var(--app-text-subtle)] focus-visible:ring-[var(--app-warm)]"
                            />
                        </div>

                        <div>
                            <label
                                htmlFor="organisation"
                                className="block text-sm font-medium text-[var(--app-text-muted)] mb-2"
                            >
                                Organisation{" "}
                                <span className="text-[var(--app-text-subtle)] font-normal">
                                    (optional)
                                </span>
                            </label>
                            <Input
                                id="organisation"
                                type="text"
                                value={organisation}
                                onChange={(e) =>
                                    setOrganisation(e.target.value)
                                }
                                placeholder="Your organisation"
                                className="w-full border-[var(--app-border)] bg-[var(--app-command-input)] text-[var(--app-text-strong)] shadow-none placeholder:text-[var(--app-text-subtle)] focus-visible:ring-[var(--app-warm)]"
                            />
                        </div>

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
                                placeholder="Create a password (min. 6 characters)"
                                required
                                className="w-full border-[var(--app-border)] bg-[var(--app-command-input)] text-[var(--app-text-strong)] shadow-none placeholder:text-[var(--app-text-subtle)] focus-visible:ring-[var(--app-warm)]"
                            />
                        </div>

                        <div>
                            <label
                                htmlFor="confirmPassword"
                                className="block text-sm font-medium text-[var(--app-text-muted)] mb-2"
                            >
                                Confirm Password
                            </label>
                            <Input
                                id="confirmPassword"
                                type="password"
                                value={confirmPassword}
                                onChange={(e) =>
                                    setConfirmPassword(e.target.value)
                                }
                                placeholder="Confirm your password"
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
                            className="w-full bg-gradient-to-b from-amber-200 to-amber-500 text-black hover:from-amber-100 hover:to-amber-400"
                        >
                            {loading ? "Creating account..." : "Sign up"}
                        </Button>
                    </form>

                    {/* Terms and Privacy: the deployer's own documents, shown only when configured */}
                    {(() => {
                        const terms = termsUrl();
                        const privacy = privacyUrl();
                        if (!terms && !privacy) return null;
                        return (
                            <div className="mt-4 text-center text-xs text-[var(--app-text-subtle)]">
                                By signing up, you agree to the{" "}
                                {terms ? (
                                    <Link
                                        href={terms}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-[var(--app-warm)] hover:underline"
                                    >
                                        Terms of Use
                                    </Link>
                                ) : null}
                                {terms && privacy ? " and " : null}
                                {privacy ? (
                                    <Link
                                        href={privacy}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-[var(--app-warm)] hover:underline"
                                    >
                                        Privacy Policy
                                    </Link>
                                ) : null}
                                .
                            </div>
                        );
                    })()}
                </div>
                <p className="text-center text-xs text-[var(--app-text-subtle)] leading-relaxed px-2">
                    Cocoa Legal is currently a demo service. Please do not
                    upload, submit, or store sensitive, confidential,
                    privileged, client, or personally identifiable documents.
                </p>
            </div>
        </AuthShell>
    );
}
