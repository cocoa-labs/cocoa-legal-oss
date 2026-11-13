// Whether the matter page shows the controlled-beta panel and holds uploads
// until the data policy is accepted. Both follow beta mode: outside it the
// backend reports the policy as `enabled: false`.

export type ProjectBetaGate = { showPanel: boolean; uploadsBlocked: boolean };

export function projectBetaGate(
    policy: { enabled: boolean; accepted: boolean } | null,
): ProjectBetaGate {
    if (!policy?.enabled) return { showPanel: false, uploadsBlocked: false };
    return { showPanel: true, uploadsBlocked: !policy.accepted };
}
