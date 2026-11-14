"use client";

import { useEffect, useState } from "react";

import { getUserBetaPolicy } from "./cocoaLegalApi";

/**
 * Whether in-app signatures are labelled nonbinding under the current
 * organization policy. Treated as nonbinding until the policy loads, and if
 * it can't be read.
 */
export function useSignaturesNonbinding(): boolean {
    const [nonbinding, setNonbinding] = useState(true);
    useEffect(() => {
        let active = true;
        getUserBetaPolicy()
            .then((policy) => {
                if (active) setNonbinding(policy.signatures_nonbinding !== false);
            })
            .catch(() => {
                if (active) setNonbinding(true);
            });
        return () => {
            active = false;
        };
    }, []);
    return nonbinding;
}
