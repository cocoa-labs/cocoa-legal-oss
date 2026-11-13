import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { DEFAULT_TABULAR_MODEL, resolveModel } from "../lib/llm";
import {
  type ApiKeyStatus,
  getUserApiKeyStatus,
  hasEnvApiKey,
  normalizeApiKeyProvider,
  saveUserApiKey,
} from "../lib/userApiKeys";
import {
  betaPolicyAllowlistIsValid,
  ensurePersonalBetaPolicyOrganization,
  getBetaPolicyState,
  normalizeBetaPolicyAllowlist,
} from "../lib/betaPolicy";
import { authorize } from "../lib/authorization";
import { recordAuditEvent } from "../lib/audit";

export const userRouter = Router();

const MONTHLY_CREDIT_LIMIT = 999999;
const MAX_DISPLAY_NAME_LENGTH = 80;

type UserProfileRow = {
  display_name: string | null;
  organisation: string | null;
  message_credits_used: number;
  credits_reset_date: string;
  tier: string;
  tabular_model: string;
};

function serializeProfile(row: UserProfileRow, apiKeyStatus?: ApiKeyStatus) {
  const creditsUsed = row.message_credits_used ?? 0;
  return {
    displayName: row.display_name,
    organisation: row.organisation,
    messageCreditsUsed: creditsUsed,
    creditsResetDate: row.credits_reset_date,
    creditsRemaining: Math.max(MONTHLY_CREDIT_LIMIT - creditsUsed, 0),
    tier: row.tier || "Free",
    tabularModel: resolveModel(row.tabular_model, DEFAULT_TABULAR_MODEL),
    ...(apiKeyStatus ? { apiKeyStatus } : {}),
  };
}

function validateProfilePayload(body: unknown):
  | {
      ok: true;
      update: {
        display_name?: string | null;
        organisation?: string | null;
        tabular_model?: string;
        updated_at: string;
      };
    }
  | { ok: false; detail: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, detail: "Expected a JSON object" };
  }

  const raw = body as Record<string, unknown>;
  const allowedFields = new Set([
    "displayName",
    "organisation",
    "tabularModel",
  ]);
  const invalidField = Object.keys(raw).find((key) => !allowedFields.has(key));
  if (invalidField) {
    return { ok: false, detail: `Unsupported profile field: ${invalidField}` };
  }

  const update: {
    display_name?: string | null;
    organisation?: string | null;
    tabular_model?: string;
    updated_at: string;
  } = { updated_at: new Date().toISOString() };

  if ("displayName" in raw) {
    if (raw.displayName !== null && typeof raw.displayName !== "string") {
      return { ok: false, detail: "displayName must be a string or null" };
    }
    const displayName = raw.displayName?.trim() || null;
    if (displayName && displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      return {
        ok: false,
        detail: `displayName must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer`,
      };
    }
    update.display_name = displayName;
  }

  if ("organisation" in raw) {
    if (raw.organisation !== null && typeof raw.organisation !== "string") {
      return { ok: false, detail: "organisation must be a string or null" };
    }
    update.organisation = raw.organisation?.trim() || null;
  }

  if ("tabularModel" in raw) {
    if (typeof raw.tabularModel !== "string") {
      return { ok: false, detail: "tabularModel must be a string" };
    }
    const resolved = resolveModel(raw.tabularModel, "");
    if (!resolved) {
      return { ok: false, detail: "Unsupported tabularModel" };
    }
    update.tabular_model = resolved;
  }

  return { ok: true, update };
}

async function ensureProfileRow(
  db: ReturnType<typeof createServerSupabase>,
  userId: string,
) {
  const { error } = await db
    .from("user_profiles")
    .upsert(
      { user_id: userId },
      { onConflict: "user_id", ignoreDuplicates: true },
    );
  return error;
}

async function loadProfile(
  db: ReturnType<typeof createServerSupabase>,
  userId: string,
  options: { repairMissing?: boolean } = {},
) {
  let { data, error } = await db
    .from("user_profiles")
    .select(
      "display_name, organisation, message_credits_used, credits_reset_date, tier, tabular_model",
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (error) return { data: null, error };
  if (!data) {
    if (!options.repairMissing) {
      return { data: null, error: new Error("Profile not found") };
    }

    const ensureError = await ensureProfileRow(db, userId);
    if (ensureError) return { data: null, error: ensureError };

    const created = await db
      .from("user_profiles")
      .select(
        "display_name, organisation, message_credits_used, credits_reset_date, tier, tabular_model",
      )
      .eq("user_id", userId)
      .single();
    if (created.error) return { data: null, error: created.error };
    data = created.data;
  }

  let row = data as UserProfileRow;
  if (row.credits_reset_date && new Date() > new Date(row.credits_reset_date)) {
    const creditsResetDate = new Date();
    creditsResetDate.setDate(creditsResetDate.getDate() + 30);
    const { data: resetData, error: resetError } = await db
      .from("user_profiles")
      .update({
        message_credits_used: 0,
        credits_reset_date: creditsResetDate.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .select(
        "display_name, organisation, message_credits_used, credits_reset_date, tier, tabular_model",
      )
      .single();

    if (resetError) return { data: null, error: resetError };
    row = resetData as UserProfileRow;
  }

  return { data: serializeProfile(row), error: null };
}

// POST /user/profile
userRouter.post("/profile", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const error = await ensureProfileRow(db, userId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.json({ ok: true });
});

// GET /user/profile
userRouter.get("/profile", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { data, error } = await loadProfile(db, userId, {
    repairMissing: true,
  });
  if (error) return void res.status(500).json({ detail: error.message });
  const apiKeyStatus = await getUserApiKeyStatus(userId, db);
  res.json({ ...data, apiKeyStatus });
});

// PATCH /user/profile
userRouter.patch("/profile", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const parsed = validateProfilePayload(req.body);
  if (!parsed.ok) return void res.status(400).json({ detail: parsed.detail });

  const db = createServerSupabase();
  const ensureError = await ensureProfileRow(db, userId);
  if (ensureError)
    return void res.status(500).json({ detail: ensureError.message });

  const { error: updateError } = await db
    .from("user_profiles")
    .update(parsed.update)
    .eq("user_id", userId);
  if (updateError)
    return void res.status(500).json({ detail: updateError.message });

  const { data, error } = await loadProfile(db, userId);
  if (error) return void res.status(500).json({ detail: error.message });
  const apiKeyStatus = await getUserApiKeyStatus(userId, db);
  res.json({ ...data, apiKeyStatus });
});

async function userBetaPolicyResponse(
  db: ReturnType<typeof createServerSupabase>,
  userId: string,
  userEmail: string | undefined,
) {
  const policy = await getBetaPolicyState(db, { userId, userEmail });
  const canManage = policy.organization_id
    ? (
        await authorize({
          db,
          userId,
          userEmail,
          action: "matter:admin",
          resource: { orgId: policy.organization_id },
        })
      ).ok
    : true;
  return {
    ...policy,
    available: Boolean(policy.organization_id),
    can_manage: policy.enabled && canManage,
  };
}

// GET /user/beta-policy — permanent, discoverable policy settings. This is
// organization-scoped even though it lives under /user: the current user's
// active organization membership selects the workspace, and can_manage makes
// the authority boundary explicit to the client.
userRouter.get("/beta-policy", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const db = createServerSupabase();
  try {
    res.json(await userBetaPolicyResponse(db, userId, userEmail));
  } catch (error) {
    console.error("[user/beta-policy] load failed", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      code: "BETA_POLICY_UNAVAILABLE",
      detail: "The controlled-beta safeguards are temporarily unavailable.",
    });
  }
});

// PATCH /user/beta-policy — accept the policy and manage the organization-wide
// calendar/signature beta participant list. Standard email is unrestricted. A
// first organization is created only after this
// explicit action, so read-only account visits never mutate tenancy state.
userRouter.patch("/beta-policy", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const acceptPolicy = req.body?.accept_data_policy === true;
  if (acceptPolicy && req.body?.policy_acknowledged !== true) {
    return void res.status(400).json({
      code: "BETA_POLICY_ACKNOWLEDGEMENT_REQUIRED",
      detail:
        "Confirm that you understand the controlled-beta data restrictions.",
    });
  }

  const emails = normalizeBetaPolicyAllowlist(
    req.body?.allowed_recipient_emails,
    "email",
  );
  const domains = normalizeBetaPolicyAllowlist(
    req.body?.allowed_recipient_domains,
    "domain",
  );
  if (!acceptPolicy && emails === undefined && domains === undefined) {
    return void res.status(400).json({
      code: "BETA_POLICY_ACTION_REQUIRED",
      detail: "Choose a controlled-beta setting to update.",
    });
  }
  if (!betaPolicyAllowlistIsValid(emails, domains)) {
    return void res.status(400).json({
      code: "INVALID_BETA_ALLOWLIST",
      detail: "Enter complete email addresses or domains such as example.com.",
    });
  }

  const db = createServerSupabase();
  try {
    let current = await getBetaPolicyState(db, { userId, userEmail });
    if (current.organization_id) {
      const access = await authorize({
        db,
        userId,
        userEmail,
        action: "matter:admin",
        resource: { orgId: current.organization_id },
      });
      if (!access.ok) {
        return void res.status(403).json({
          code: "ORGANIZATION_ADMIN_REQUIRED",
          detail:
            "An organization owner or admin must update these safeguards.",
        });
      }
    }
    const organizationId =
      current.organization_id ??
      (await ensurePersonalBetaPolicyOrganization(db, {
        userId,
        userEmail,
      }));
    if (!current.organization_id) {
      current = await getBetaPolicyState(db, {
        orgId: organizationId,
        userId,
      });
    }

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (acceptPolicy) {
      updates.data_policy_accepted_at = new Date().toISOString();
      updates.data_policy_accepted_by_user_id = userId;
    }
    if (emails !== undefined) updates.allowed_recipient_emails = emails;
    if (domains !== undefined) updates.allowed_recipient_domains = domains;
    const { error } = await db
      .from("organization_beta_policies")
      .upsert(
        { organization_id: organizationId, ...updates },
        { onConflict: "organization_id" },
      );
    if (error) throw error;

    await recordAuditEvent(db, {
      orgId: organizationId,
      actorUserId: userId,
      eventType: "beta_policy.updated",
      targetType: "organization",
      targetId: organizationId,
      requestId: String(res.getHeader("x-request-id") ?? ""),
      metadata: { source: "account_settings", accepted_policy: acceptPolicy },
    });
    res.json(await userBetaPolicyResponse(db, userId, userEmail));
  } catch (error) {
    console.error("[user/beta-policy] update failed", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      code: "BETA_POLICY_UPDATE_FAILED",
      detail: "Could not update the controlled-beta safeguards.",
    });
  }
});

// GET /user/api-keys
userRouter.get("/api-keys", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const status = await getUserApiKeyStatus(userId, db);
  res.json(status);
});

// PUT /user/api-keys/:provider
userRouter.put("/api-keys/:provider", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const provider = normalizeApiKeyProvider(req.params.provider);
  if (!provider)
    return void res.status(400).json({ detail: "Unsupported provider" });

  const apiKey =
    typeof req.body?.api_key === "string" ? req.body.api_key : null;
  const db = createServerSupabase();
  try {
    if (hasEnvApiKey(provider)) {
      return void res.status(409).json({
        detail:
          "This provider is configured by the server environment and cannot be changed from the browser.",
      });
    }
    await saveUserApiKey(userId, provider, apiKey, db);
    const status = await getUserApiKeyStatus(userId, db);
    res.json(status);
  } catch (err) {
    console.error("[user/api-keys] save failed", {
      provider,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ detail: "Failed to save API key" });
  }
});

// DELETE /user/account
userRouter.delete("/account", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { error } = await db.auth.admin.deleteUser(userId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});
