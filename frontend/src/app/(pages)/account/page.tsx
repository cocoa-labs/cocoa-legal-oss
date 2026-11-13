"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    AlertTriangle,
    LogOut,
    Check,
    Loader2,
    ShieldCheck,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useUserProfile } from "@/contexts/UserProfileContext";
import {
    deleteAccount,
    getUserBetaPolicy,
    updateUserBetaPolicy,
    type ManagedBetaPolicy,
} from "@/app/lib/cocoLegalApi";
import { MAX_DISPLAY_NAME_LENGTH } from "@/lib/userIdentity";
import { ControlledBetaPolicySummary } from "@/app/components/legal/ControlledBetaPolicySummary";

export default function AccountPage() {
    const router = useRouter();
    const { user, signOut } = useAuth();
    const { profile, updateDisplayName, updateOrganisation } = useUserProfile();
    const [displayNameDraft, setDisplayNameDraft] = useState<string | null>(
        null,
    );
    const [isSavingName, setIsSavingName] = useState(false);
    const [nameSaved, setNameSaved] = useState(false);
    const [nameError, setNameError] = useState<string | null>(null);
    const [organisationDraft, setOrganisationDraft] = useState<string | null>(
        null,
    );
    const [isSavingOrg, setIsSavingOrg] = useState(false);
    const [orgSaved, setOrgSaved] = useState(false);
    const [orgError, setOrgError] = useState<string | null>(null);
    const [deleteConfirm, setDeleteConfirm] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [betaPolicy, setBetaPolicy] = useState<ManagedBetaPolicy | null>(
        null,
    );
    const [betaPolicyLoading, setBetaPolicyLoading] = useState(true);
    const [betaPolicySaving, setBetaPolicySaving] = useState(false);
    const [betaEmails, setBetaEmails] = useState("");
    const [betaDomains, setBetaDomains] = useState("");
    const [betaPolicyAcknowledged, setBetaPolicyAcknowledged] = useState(false);
    const [betaPolicySaved, setBetaPolicySaved] = useState(false);
    const [betaPolicyError, setBetaPolicyError] = useState<string | null>(null);

    const savedDisplayName = profile?.displayName ?? "";
    const displayName = displayNameDraft ?? savedDisplayName;
    const normalizedDisplayName = displayName.trim();
    const displayNameDirty =
        displayNameDraft !== null &&
        normalizedDisplayName !== savedDisplayName.trim();
    const displayNameTooLong =
        normalizedDisplayName.length > MAX_DISPLAY_NAME_LENGTH;
    const canSaveDisplayName =
        displayNameDirty && !displayNameTooLong && !isSavingName && !nameSaved;

    const savedOrganisation = profile?.organisation ?? "";
    const organisation = organisationDraft ?? savedOrganisation;
    const organisationDirty =
        organisationDraft !== null &&
        organisation.trim() !== savedOrganisation.trim();
    const canSaveOrganisation = organisationDirty && !isSavingOrg && !orgSaved;

    const applyBetaPolicy = (policy: ManagedBetaPolicy) => {
        setBetaPolicy(policy);
        setBetaEmails(policy.allowed_recipient_emails.join(", "));
        setBetaDomains(policy.allowed_recipient_domains.join(", "));
    };

    const loadBetaPolicy = async () => {
        setBetaPolicyLoading(true);
        setBetaPolicyError(null);
        try {
            applyBetaPolicy(await getUserBetaPolicy());
        } catch (reason) {
            setBetaPolicyError(
                reason instanceof Error
                    ? reason.message
                    : "Could not load the controlled-beta safeguards.",
            );
        } finally {
            setBetaPolicyLoading(false);
        }
    };

    useEffect(() => {
        if (user) void loadBetaPolicy();
        // The authenticated account is the scope; reload when it changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user?.id]);

    const handleLogout = async () => {
        await signOut();
        router.push("/");
    };

    const handleDeleteAccount = async () => {
        setIsDeleting(true);
        try {
            await deleteAccount();
            await signOut();
            router.push("/");
        } catch {
            setIsDeleting(false);
            setDeleteConfirm(false);
            alert("Failed to delete account. Please try again.");
        }
    };

    const handleSaveDisplayName = async () => {
        if (displayNameTooLong) {
            setNameError(
                `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.`,
            );
            return;
        }

        setIsSavingName(true);
        setNameError(null);
        const success = await updateDisplayName(normalizedDisplayName || null);
        setIsSavingName(false);

        if (success) {
            setDisplayNameDraft(null);
            setNameSaved(true);
            setTimeout(() => setNameSaved(false), 2000);
        } else {
            setNameError("Failed to update display name. Please try again.");
        }
    };

    const handleSaveOrganisation = async () => {
        setIsSavingOrg(true);
        setOrgError(null);
        const success = await updateOrganisation(organisation.trim());
        setIsSavingOrg(false);

        if (success) {
            setOrganisationDraft(null);
            setOrgSaved(true);
            setTimeout(() => setOrgSaved(false), 2000);
        } else {
            setOrgError("Failed to update organisation. Please try again.");
        }
    };

    const handleSaveBetaPolicy = async () => {
        if (!betaPolicy?.can_manage) return;
        const parse = (value: string) =>
            value
                .split(/[\s,]+/)
                .map((entry) => entry.trim().toLowerCase())
                .filter(Boolean);
        setBetaPolicySaving(true);
        setBetaPolicySaved(false);
        setBetaPolicyError(null);
        try {
            const updated = await updateUserBetaPolicy({
                accept_data_policy: !betaPolicy.accepted || undefined,
                policy_acknowledged:
                    !betaPolicy.accepted && betaPolicyAcknowledged
                        ? true
                        : undefined,
                allowed_recipient_emails: parse(betaEmails),
                allowed_recipient_domains: parse(betaDomains),
            });
            applyBetaPolicy(updated);
            setBetaPolicyAcknowledged(false);
            setBetaPolicySaved(true);
            setTimeout(() => setBetaPolicySaved(false), 2500);
        } catch (reason) {
            setBetaPolicyError(
                reason instanceof Error
                    ? reason.message
                    : "Could not update the controlled-beta safeguards.",
            );
        } finally {
            setBetaPolicySaving(false);
        }
    };

    if (!user) return null;

    return (
        <div className="space-y-4 text-[var(--app-text)]">
            {/* Profile Settings */}
            <div className="pb-6">
                <div className="flex items-center gap-2 mb-4">
                    <h2 className="text-2xl font-medium font-serif text-[var(--app-text-strong)]">
                        Profile
                    </h2>
                </div>
                <div className="space-y-4">
                    <div>
                        <label className="text-sm text-[var(--app-text-muted)] block mb-2">
                            Display Name
                        </label>
                        <div className="flex gap-2">
                            <Input
                                type="text"
                                value={displayName}
                                onChange={(e) => {
                                    setDisplayNameDraft(e.target.value);
                                    setNameSaved(false);
                                    setNameError(null);
                                }}
                                placeholder="Name shown in the app"
                                maxLength={MAX_DISPLAY_NAME_LENGTH}
                                className="flex-1 bg-[var(--app-command-input)]"
                            />
                            <Button
                                onClick={handleSaveDisplayName}
                                disabled={!canSaveDisplayName}
                                className="min-w-[80px] transition-all bg-[var(--app-active-strong)] text-[var(--app-active-foreground)] hover:opacity-90"
                            >
                                {isSavingName ? (
                                    "Saving..."
                                ) : nameSaved ? (
                                    <>
                                        <Check className="h-4 w-3" />
                                        Saved
                                    </>
                                ) : (
                                    "Save"
                                )}
                            </Button>
                        </div>
                        <div className="mt-1 flex items-center justify-between gap-3">
                            <p className="text-xs text-[var(--app-text-subtle)]">
                                Leave blank to use a neutral greeting.
                            </p>
                            <p
                                className={`text-xs ${
                                    displayNameTooLong
                                        ? "text-red-600"
                                        : "text-[var(--app-text-subtle)]"
                                }`}
                            >
                                {normalizedDisplayName.length}/
                                {MAX_DISPLAY_NAME_LENGTH}
                            </p>
                        </div>
                        {nameError && (
                            <p className="mt-1 text-xs text-red-600">
                                {nameError}
                            </p>
                        )}
                    </div>
                    <div>
                        <label className="text-sm text-[var(--app-text-muted)] block mb-2">
                            Organisation
                        </label>
                        <div className="flex gap-2">
                            <Input
                                type="text"
                                value={organisation}
                                onChange={(e) => {
                                    setOrganisationDraft(e.target.value);
                                    setOrgSaved(false);
                                    setOrgError(null);
                                }}
                                placeholder="Enter your organisation"
                                className="flex-1 bg-[var(--app-command-input)]"
                            />
                            <Button
                                onClick={handleSaveOrganisation}
                                disabled={!canSaveOrganisation}
                                className="min-w-[80px] transition-all bg-[var(--app-active-strong)] text-[var(--app-active-foreground)] hover:opacity-90"
                            >
                                {isSavingOrg ? (
                                    "Saving..."
                                ) : orgSaved ? (
                                    <>
                                        <Check className="h-4 w-3" />
                                        Saved
                                    </>
                                ) : (
                                    "Save"
                                )}
                            </Button>
                        </div>
                        {orgError && (
                            <p className="mt-1 text-xs text-red-600">
                                {orgError}
                            </p>
                        )}
                    </div>
                    <div>
                        <label className="text-sm text-[var(--app-text-muted)] block mb-2">
                            Email
                        </label>
                        <p className="text-base">{user?.email}</p>
                    </div>
                </div>
            </div>

            {/* Data policy and outbound safeguards */}
            <section id="controlled-beta-policy" className="scroll-mt-6 py-6">
                <div className="mb-4 flex flex-wrap items-center gap-2">
                    <ShieldCheck className="h-5 w-5 text-[var(--app-warm)]" />
                    <h2 className="text-2xl font-medium font-serif text-[var(--app-text-strong)]">
                        Data &amp; outbound safeguards
                    </h2>
                    {betaPolicy?.enabled ? (
                        <span
                            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                                betaPolicy.accepted
                                    ? "bg-green-100 text-green-800"
                                    : "bg-amber-100 text-amber-900"
                            }`}
                        >
                            {betaPolicy.accepted
                                ? "Policy accepted"
                                : "Action required"}
                        </span>
                    ) : null}
                </div>

                {betaPolicyLoading ? (
                    <div className="inline-flex items-center gap-2 text-sm text-[var(--app-text-muted)]">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading safeguards…
                    </div>
                ) : betaPolicy?.enabled ? (
                    <div className="max-w-3xl rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-4">
                        <ControlledBetaPolicySummary />

                        {betaPolicy.accepted &&
                        betaPolicy.data_policy_accepted_at ? (
                            <p className="mt-3 text-xs font-medium text-green-700">
                                Accepted for this organization on{" "}
                                {new Date(
                                    betaPolicy.data_policy_accepted_at,
                                ).toLocaleDateString()}
                                .
                            </p>
                        ) : null}

                        {betaPolicy.can_manage ? (
                            <div className="mt-4 space-y-3 border-t border-[var(--app-border)] pt-4">
                                {!betaPolicy.accepted ? (
                                    <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-5 text-amber-950">
                                        <input
                                            type="checkbox"
                                            checked={betaPolicyAcknowledged}
                                            onChange={(event) =>
                                                setBetaPolicyAcknowledged(
                                                    event.target.checked,
                                                )
                                            }
                                            className="mt-0.5 h-4 w-4 shrink-0 accent-amber-900"
                                        />
                                        <span>
                                            I am authorized to accept this
                                            policy for my organization, and I
                                            agree to the controlled-beta
                                            restrictions above.
                                        </span>
                                    </label>
                                ) : null}

                                <div className="grid gap-3 sm:grid-cols-2">
                                    <div>
                                        <label className="mb-1.5 block text-sm font-medium text-[var(--app-text-strong)]">
                                            Approved calendar/signature
                                            addresses
                                        </label>
                                        <Input
                                            value={betaEmails}
                                            onChange={(event) => {
                                                setBetaEmails(
                                                    event.target.value,
                                                );
                                                setBetaPolicySaved(false);
                                                setBetaPolicyError(null);
                                            }}
                                            placeholder="tester@example.com"
                                            className="bg-[var(--app-command-input)]"
                                        />
                                        <p className="mt-1 text-xs text-[var(--app-text-subtle)]">
                                            Separate multiple addresses with
                                            commas or spaces. Standard email is
                                            not restricted by this list.
                                        </p>
                                    </div>
                                    <div>
                                        <label className="mb-1.5 block text-sm font-medium text-[var(--app-text-strong)]">
                                            Approved calendar/signature domains
                                        </label>
                                        <Input
                                            value={betaDomains}
                                            onChange={(event) => {
                                                setBetaDomains(
                                                    event.target.value,
                                                );
                                                setBetaPolicySaved(false);
                                                setBetaPolicyError(null);
                                            }}
                                            placeholder="pilot-firm.test"
                                            className="bg-[var(--app-command-input)]"
                                        />
                                        <p className="mt-1 text-xs text-[var(--app-text-subtle)]">
                                            A domain approves every address at
                                            that domain.
                                        </p>
                                    </div>
                                </div>

                                <div className="flex flex-wrap items-center gap-2">
                                    <Button
                                        onClick={() =>
                                            void handleSaveBetaPolicy()
                                        }
                                        disabled={
                                            betaPolicySaving ||
                                            (!betaPolicy.accepted &&
                                                !betaPolicyAcknowledged)
                                        }
                                        className="bg-[var(--app-active-strong)] text-[var(--app-active-foreground)] hover:opacity-90"
                                    >
                                        {betaPolicySaving ? (
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                        ) : betaPolicySaved ? (
                                            <Check className="h-4 w-4" />
                                        ) : (
                                            <ShieldCheck className="h-4 w-4" />
                                        )}
                                        {betaPolicySaving
                                            ? "Saving…"
                                            : betaPolicySaved
                                              ? "Saved"
                                              : betaPolicy.accepted
                                                ? "Save safeguards"
                                                : "Accept policy & save"}
                                    </Button>
                                    <span className="text-xs text-[var(--app-text-subtle)]">
                                        Changes apply across your organization.
                                    </span>
                                </div>
                            </div>
                        ) : (
                            <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
                                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                                <p>
                                    Only an organization owner or admin can
                                    accept this policy or change restricted beta
                                    action participants. Standard email
                                    recipients are unrestricted.
                                </p>
                            </div>
                        )}
                    </div>
                ) : betaPolicy ? (
                    <p className="text-sm text-[var(--app-text-muted)]">
                        Controlled-beta restrictions are not enabled for this
                        environment.
                    </p>
                ) : null}

                {betaPolicyError ? (
                    <div
                        role="alert"
                        className="mt-3 flex max-w-3xl items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
                    >
                        <span>{betaPolicyError}</span>
                        {!betaPolicy ? (
                            <button
                                type="button"
                                onClick={() => void loadBetaPolicy()}
                                className="shrink-0 font-semibold underline underline-offset-2"
                            >
                                Retry
                            </button>
                        ) : null}
                    </div>
                ) : null}
            </section>

            {/* Plan */}
            <div className="py-6">
                <div className="flex items-center gap-2 mb-4">
                    <h2 className="text-2xl font-medium font-serif text-[var(--app-text-strong)]">
                        Usage Plan
                    </h2>
                </div>
                <div>
                    <p className="text-base font-medium text-[var(--app-text-muted)] capitalize">
                        {profile?.tier || "Free"}
                    </p>
                </div>
            </div>

            {/* Actions */}
            <div className="py-6">
                <h2 className="text-2xl font-medium font-serif mb-4 text-[var(--app-text-strong)]">
                    Actions
                </h2>
                <Button
                    variant="outline"
                    onClick={handleLogout}
                    className="w-full sm:w-auto"
                >
                    <LogOut className="h-4 w-4 mr-2" />
                    Sign Out
                </Button>
            </div>

            {/* Danger Zone */}
            <div className="py-6">
                <h2 className="text-2xl font-medium font-serif mb-1 text-red-600">
                    Danger Zone
                </h2>
                <p className="text-sm text-[var(--app-text-muted)] mb-4">
                    Permanently delete your account and all associated data.
                    This action cannot be undone.
                </p>
                {deleteConfirm ? (
                    <div className="rounded-lg border border-red-200 bg-red-50 p-4 space-y-3 max-w-sm">
                        <p className="text-sm font-medium text-red-700">
                            Are you sure? This will permanently delete your
                            account.
                        </p>
                        <div className="flex gap-2">
                            <Button
                                variant="outline"
                                onClick={() => setDeleteConfirm(false)}
                                disabled={isDeleting}
                                className="text-sm"
                            >
                                Cancel
                            </Button>
                            <Button
                                onClick={handleDeleteAccount}
                                disabled={isDeleting}
                                className="text-sm bg-red-600 hover:bg-red-700 text-white"
                            >
                                {isDeleting ? "Deleting…" : "Delete Account"}
                            </Button>
                        </div>
                    </div>
                ) : (
                    <Button
                        variant="outline"
                        onClick={() => setDeleteConfirm(true)}
                        className="w-full sm:w-auto border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
                    >
                        Delete Account
                    </Button>
                )}
            </div>
        </div>
    );
}
