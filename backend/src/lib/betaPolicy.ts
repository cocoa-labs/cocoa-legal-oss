import type { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

export type BetaPolicyState = {
  enabled: boolean;
  organization_id: string | null;
  accepted: boolean;
  data_policy_accepted_at: string | null;
  allowed_recipient_emails: string[];
  allowed_recipient_domains: string[];
  signatures_nonbinding: boolean;
};

export type BetaPolicyErrorCode =
  | "BETA_RECIPIENT_NOT_ALLOWED"
  | "BETA_DATA_POLICY_REQUIRED";

export class BetaPolicyError extends Error {
  readonly status = 403;
  constructor(
    readonly code: BetaPolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BetaPolicyError";
  }
}

export function betaModeEnabled(): boolean {
  return ["1", "true", "yes", "on"].includes(
    (process.env.BETA_MODE ?? "").trim().toLowerCase(),
  );
}

function normalizedStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean)
    : [];
}

export async function resolveBetaPolicyOrganizationId(
  db: Db,
  input: {
    orgId?: string | null;
    projectId?: string | null;
    userId: string;
    userEmail?: string | null;
  },
): Promise<string | null> {
  if (input.orgId) return input.orgId;
  if (input.projectId) {
    const { data } = await db
      .from("projects")
      .select("org_id, matter_id")
      .eq("id", input.projectId)
      .maybeSingle();
    if (data?.org_id && data?.matter_id) {
      let membership = db
        .from("matter_memberships")
        .select("id")
        .eq("matter_id", data.matter_id)
        .eq("status", "active");
      const normalizedEmail = input.userEmail?.trim().toLowerCase();
      membership = normalizedEmail
        ? membership.or(
            `user_id.eq.${input.userId},email.ilike.${normalizedEmail}`,
          )
        : membership.eq("user_id", input.userId);
      const { data: active } = await membership.limit(1).maybeSingle();
      if (active) return String(data.org_id);
    }
  }
  const { data } = await db
    .from("organization_memberships")
    .select("organization_id")
    .eq("user_id", input.userId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (data?.organization_id) return String(data.organization_id);

  const normalizedEmail = input.userEmail?.trim().toLowerCase();
  if (!normalizedEmail) return null;
  const { data: byEmail } = await db
    .from("organization_memberships")
    .select("organization_id")
    .ilike("email", normalizedEmail)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return byEmail?.organization_id ? String(byEmail.organization_id) : null;
}

/**
 * Read the controlled-beta policy in the same scope used by the upload and
 * outbound-action enforcement gates. UI preflight endpoints use this instead
 * of guessing a policy from whichever matter happens to be open.
 */
export async function getBetaPolicyState(
  db: Db,
  input: {
    orgId?: string | null;
    projectId?: string | null;
    userId: string;
    userEmail?: string | null;
  },
): Promise<BetaPolicyState> {
  if (!betaModeEnabled()) {
    // Outside beta mode the app makes no claim either way about whether a
    // signature binds anyone; consent copy stays neutral.
    return {
      enabled: false,
      organization_id: null,
      accepted: true,
      data_policy_accepted_at: null,
      allowed_recipient_emails: [],
      allowed_recipient_domains: [],
      signatures_nonbinding: false,
    };
  }

  const organizationId = await resolveBetaPolicyOrganizationId(db, input);
  if (!organizationId) {
    return {
      enabled: true,
      organization_id: null,
      accepted: false,
      data_policy_accepted_at: null,
      allowed_recipient_emails: [],
      allowed_recipient_domains: [],
      signatures_nonbinding: true,
    };
  }

  const { data, error } = await db
    .from("organization_beta_policies")
    .select(
      "data_policy_accepted_at, allowed_recipient_emails, allowed_recipient_domains, signatures_nonbinding",
    )
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  return {
    enabled: true,
    organization_id: organizationId,
    accepted: Boolean(data?.data_policy_accepted_at),
    data_policy_accepted_at: data?.data_policy_accepted_at ?? null,
    allowed_recipient_emails: normalizedStrings(data?.allowed_recipient_emails),
    allowed_recipient_domains: normalizedStrings(
      data?.allowed_recipient_domains,
    ).map((domain) => domain.replace(/^@/, "")),
    signatures_nonbinding: data?.signatures_nonbinding ?? true,
  };
}

/** The organization_beta_policies columns the matter page reads. */
export type BetaPolicyRow = {
  data_policy_accepted_at?: string | null;
  allowed_recipient_emails?: string[] | null;
  allowed_recipient_domains?: string[] | null;
  signatures_nonbinding?: boolean | null;
};

/** What the matter page's controlled-beta panel receives. */
export type ProjectBetaPolicyView = Omit<BetaPolicyState, "organization_id">;

/**
 * The matter page's view of the policy. In beta mode it is the organization's
 * row; outside beta mode it reports the policy disabled (no panel, no upload
 * gate, neutral signature wording), the same state getBetaPolicyState returns.
 */
export function projectBetaPolicyView(
  row: BetaPolicyRow | null,
  enabled: boolean,
): ProjectBetaPolicyView {
  if (!enabled) {
    return {
      enabled: false,
      accepted: true,
      data_policy_accepted_at: null,
      allowed_recipient_emails: [],
      allowed_recipient_domains: [],
      signatures_nonbinding: false,
    };
  }
  return {
    enabled: true,
    accepted: Boolean(row?.data_policy_accepted_at),
    data_policy_accepted_at: row?.data_policy_accepted_at ?? null,
    allowed_recipient_emails: row?.allowed_recipient_emails ?? [],
    allowed_recipient_domains: row?.allowed_recipient_domains ?? [],
    signatures_nonbinding: row?.signatures_nonbinding ?? true,
  };
}

/**
 * The signature label for a scope: the policy's flag in beta mode, false
 * outside it, and nonbinding when the policy can't be read. Used where no
 * signed-in user is present (the public signing page).
 */
export async function signaturesNonbindingFor(
  db: Db,
  input: {
    orgId?: string | null;
    projectId?: string | null;
    userId: string;
    userEmail?: string | null;
  },
): Promise<boolean> {
  try {
    return (await getBetaPolicyState(db, input)).signatures_nonbinding;
  } catch {
    return true;
  }
}

/** Exact recipients that the current policy would refuse. */
export function blockedBetaRecipients(
  policy: Pick<
    BetaPolicyState,
    "allowed_recipient_emails" | "allowed_recipient_domains"
  >,
  recipients: string[],
): string[] {
  const allowedEmails = new Set(
    normalizedStrings(policy.allowed_recipient_emails),
  );
  const allowedDomains = new Set(
    normalizedStrings(policy.allowed_recipient_domains).map((domain) =>
      domain.replace(/^@/, ""),
    ),
  );
  return [
    ...new Set(
      normalizedStrings(recipients).filter((email) => {
        const domain = email.split("@")[1] ?? "";
        return !allowedEmails.has(email) && !allowedDomains.has(domain);
      }),
    ),
  ];
}

export function normalizeBetaPolicyAllowlist(
  value: unknown,
  kind: "email" | "domain",
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [
    ...new Set(
      value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim().toLowerCase())
        .map((entry) => (kind === "domain" ? entry.replace(/^@/, "") : entry))
        .filter(Boolean),
    ),
  ].slice(0, 200);
}

export function betaPolicyAllowlistIsValid(
  emails: string[] | undefined,
  domains: string[] | undefined,
): boolean {
  return !(
    emails?.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ||
    domains?.some((domain) => !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain))
  );
}

/**
 * A brand-new user can draft an email before creating a matter. Acceptance
 * still needs an organization row, so create their personal workspace only on
 * the explicit PATCH/accept action (never during a read-only preflight).
 */
export async function ensurePersonalBetaPolicyOrganization(
  db: Db,
  input: { userId: string; userEmail?: string | null },
): Promise<string> {
  const existing = await resolveBetaPolicyOrganizationId(db, input);
  if (existing) return existing;

  const { data: organization, error: organizationError } = await db
    .from("organizations")
    .insert({
      name: "Cocoa Legal workspace",
      slug: `workspace-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
      created_by_user_id: input.userId,
    })
    .select("id")
    .single();
  if (organizationError || !organization) {
    throw organizationError ?? new Error("Could not create your workspace.");
  }
  const organizationId = String(organization.id);
  const { error: membershipError } = await db
    .from("organization_memberships")
    .insert({
      organization_id: organizationId,
      user_id: input.userId,
      email: input.userEmail?.trim().toLowerCase() || null,
      role: "owner",
      status: "active",
      accepted_at: new Date().toISOString(),
    });
  if (membershipError) {
    await db.from("organizations").delete().eq("id", organizationId);
    throw membershipError;
  }
  const { error: policyError } = await db
    .from("organization_beta_policies")
    .insert({ organization_id: organizationId });
  if (policyError && policyError.code !== "23505") {
    await db.from("organizations").delete().eq("id", organizationId);
    throw policyError;
  }
  return organizationId;
}

async function loadPolicy(
  db: Db,
  input: {
    orgId?: string | null;
    projectId?: string | null;
    userId: string;
    userEmail?: string | null;
  },
) {
  const policy = await getBetaPolicyState(db, input);
  if (!policy.enabled) return null;
  if (!policy.organization_id) {
    throw new BetaPolicyError(
      "BETA_DATA_POLICY_REQUIRED",
      "Your organization must accept the controlled-beta data policy before using this feature.",
    );
  }
  if (!policy.accepted) {
    throw new BetaPolicyError(
      "BETA_DATA_POLICY_REQUIRED",
      "Complete the controlled-beta safeguards before uploading or sending beta content.",
    );
  }
  return policy;
}

export async function assertBetaDataPolicy(
  db: Db,
  input: {
    orgId?: string | null;
    projectId?: string | null;
    userId: string;
    userEmail?: string | null;
  },
): Promise<void> {
  await loadPolicy(db, input);
}

export async function assertBetaRecipientsAllowed(
  db: Db,
  input: {
    orgId?: string | null;
    projectId?: string | null;
    userId: string;
    userEmail?: string | null;
    recipients: string[];
  },
): Promise<void> {
  const policy = await loadPolicy(db, input);
  if (!policy) return;
  const blocked = blockedBetaRecipients(policy, input.recipients);
  if (blocked.length > 0) {
    throw new BetaPolicyError(
      "BETA_RECIPIENT_NOT_ALLOWED",
      "One or more recipients are not approved for controlled-beta outbound actions.",
    );
  }
}
