import Link from "next/link";
import { CheckCircle2, ExternalLink } from "lucide-react";
import { privacyUrl, termsUrl } from "@/app/lib/deploymentLinks";

export function ControlledBetaPolicySummary({
    compact = false,
    showAccountLink = false,
}: {
    compact?: boolean;
    showAccountLink?: boolean;
}) {
    const terms = termsUrl();
    const privacy = privacyUrl();
    return (
        <div className={compact ? "text-xs" : "text-sm"}>
            <p className="leading-5 text-current/80">
                Controlled beta is limited to safe test use. Acceptance applies
                to your organization; it does not send an email or approve any
                other pending action.
            </p>
            <ul
                className="mt-2 space-y-1.5"
                aria-label="Controlled beta restrictions"
            >
                <li className="flex items-start gap-2">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                        Upload or send only synthetic or properly redacted
                        content—never unredacted client data.
                    </span>
                </li>
                <li className="flex items-start gap-2">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                        Verify redaction yourself; Cocoa Legal does not redact
                        documents automatically.
                    </span>
                </li>
                <li className="flex items-start gap-2">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                        Standard email may go to any address you specify.
                        Calendar and signature beta actions use approved test
                        participants; beta signatures are nonbinding.
                    </span>
                </li>
            </ul>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-medium">
                {showAccountLink ? (
                    <Link
                        href="/account#controlled-beta-policy"
                        className="underline underline-offset-2"
                    >
                        Manage policy settings
                    </Link>
                ) : null}
                {terms ? (
                    <Link
                        href={terms}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 underline underline-offset-2"
                    >
                        Terms of Use
                        <ExternalLink className="h-3 w-3" />
                    </Link>
                ) : null}
                {privacy ? (
                    <Link
                        href={privacy}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 underline underline-offset-2"
                    >
                        Privacy Policy
                        <ExternalLink className="h-3 w-3" />
                    </Link>
                ) : null}
            </div>
        </div>
    );
}
