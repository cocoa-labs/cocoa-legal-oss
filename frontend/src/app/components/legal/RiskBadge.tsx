"use client";

import { ShieldCheck, ShieldAlert, ShieldX, OctagonAlert } from "lucide-react";

export type UnifiedRiskBand = "low" | "medium" | "high" | "critical";

export interface RiskBadgeProps {
    /** Unified band — computed server-side via riskMap.ts. */
    band: UnifiedRiskBand;
    /** Optional native severity label (e.g. "GREEN", "High × Probable",
     * "material") shown alongside the band glyph for context. */
    nativeLabel?: string;
    /** Short reason summary shown in the tooltip. */
    reason?: string;
    /** Compact mode hides the native label for inline use. */
    compact?: boolean;
}

const BAND_STYLES: Record<
    UnifiedRiskBand,
    {
        bg: string;
        fg: string;
        border: string;
        Icon: typeof ShieldCheck;
        label: string;
    }
> = {
    low: {
        bg: "bg-emerald-50 dark:bg-emerald-950/40",
        fg: "text-emerald-700 dark:text-emerald-300",
        border: "border-emerald-200 dark:border-emerald-900",
        Icon: ShieldCheck,
        label: "Low",
    },
    medium: {
        bg: "bg-amber-50 dark:bg-amber-950/40",
        fg: "text-amber-700 dark:text-amber-300",
        border: "border-amber-200 dark:border-amber-900",
        Icon: ShieldAlert,
        label: "Medium",
    },
    high: {
        bg: "bg-red-50 dark:bg-red-950/40",
        fg: "text-red-700 dark:text-red-300",
        border: "border-red-200 dark:border-red-900",
        Icon: ShieldX,
        label: "High",
    },
    critical: {
        bg: "bg-rose-100 dark:bg-rose-950/60",
        fg: "text-rose-800 dark:text-rose-200",
        border: "border-rose-300 dark:border-rose-800",
        Icon: OctagonAlert,
        label: "Critical",
    },
};

export function RiskBadge({
    band,
    nativeLabel,
    reason,
    compact,
}: RiskBadgeProps) {
    const s = BAND_STYLES[band];
    const Icon = s.Icon;
    return (
        <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${s.bg} ${s.fg} ${s.border}`}
            title={reason ?? `${s.label} risk`}
        >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            <span>{s.label}</span>
            {!compact && nativeLabel && (
                <span className="opacity-70">· {nativeLabel}</span>
            )}
        </span>
    );
}
