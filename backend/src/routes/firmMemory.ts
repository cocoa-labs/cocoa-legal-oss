import { Router, type NextFunction, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { resolveFirmId } from "../lib/playbooks";
import {
    listFirmMemory,
    listFirmMemoryCandidates,
    approveFirmMemoryCandidate,
    rejectFirmMemoryCandidate,
    type FirmCandidateStatus,
} from "../lib/memory";
import { authorize, type AuthorizationAction } from "../lib/authorization";
import { createAgentOperation } from "../lib/operations";

export const firmMemoryRouter = Router();

type Db = ReturnType<typeof createServerSupabase>;
type AsyncRoute = (req: Request, res: Response) => Promise<unknown>;
function asyncRoute(handler: AsyncRoute) {
    return (req: Request, res: Response, next: NextFunction) => {
        void handler(req, res).catch(next);
    };
}

firmMemoryRouter.use(requireAuth);

/**
 * resolveFirmId returns the firm SLUG (a TEXT key for firm_playbooks /
 * firm_memory). organization_memberships (the RBAC join authorize() reads) is
 * keyed by the org UUID, so we translate slug → UUID here. Null when the firm's
 * organizations row hasn't been seeded (migration 027).
 */
async function resolveOrgId(db: Db, firmSlug: string): Promise<string | null> {
    const { data, error } = await db
        .from("organizations")
        .select("id")
        .eq("slug", firmSlug)
        .maybeSingle();
    if (error) throw new Error(`Failed to resolve firm org: ${error.message}`);
    return (data as { id?: string } | null)?.id ?? null;
}

interface FirmCtx {
    userId: string;
    userEmail: string | null;
    db: Db;
    firmId: string;
    orgId: string;
}

/**
 * Authorize the caller for `action` within the single firm. Sends the HTTP
 * error and returns null on any failure; returns the resolved context on
 * success. `operation:approve` requires role weight >= 3 (editor/lawyer/admin/
 * owner); `operation:read` allows any active member.
 */
async function authorizeFirm(
    res: Response,
    action: AuthorizationAction,
): Promise<FirmCtx | null> {
    const userId = res.locals.userId as string | undefined;
    const userEmail = (res.locals.userEmail as string | undefined) ?? null;
    if (!userId) {
        res.status(401).json({ error: "unauthorized" });
        return null;
    }
    const db = createServerSupabase();
    const firmId = await resolveFirmId(userId);
    const orgId = await resolveOrgId(db, firmId);
    if (!orgId) {
        res.status(403).json({
            error: "This firm has no organization record yet (apply migration 027).",
        });
        return null;
    }
    const decision = await authorize({
        db,
        userId,
        userEmail,
        action,
        resource: { orgId },
    });
    if (!decision.ok) {
        res.status(403).json({ error: decision.reason });
        return null;
    }
    return { userId, userEmail, db, firmId, orgId };
}

// GET /firm-memory/entries — active shared firm memory (any active member).
firmMemoryRouter.get(
    "/entries",
    asyncRoute(async (_req, res) => {
        const ctx = await authorizeFirm(res, "operation:read");
        if (!ctx) return;
        const entries = await listFirmMemory(ctx.db, ctx.firmId);
        res.json({ entries });
    }),
);

// GET /firm-memory/candidates?status=pending — the review queue.
firmMemoryRouter.get(
    "/candidates",
    asyncRoute(async (req, res) => {
        const ctx = await authorizeFirm(res, "operation:read");
        if (!ctx) return;
        const status =
            typeof req.query.status === "string"
                ? (req.query.status as FirmCandidateStatus)
                : undefined;
        const candidates = await listFirmMemoryCandidates(
            ctx.db,
            ctx.firmId,
            status,
        );
        res.json({ candidates });
    }),
);

// POST /firm-memory/candidates/:id/approve — admin approves; writes the shared
// entry + a version snapshot + a ledger record. Concurrency-safe (a second
// approve is a 409 no-op).
firmMemoryRouter.post(
    "/candidates/:id/approve",
    asyncRoute(async (req, res) => {
        const ctx = await authorizeFirm(res, "operation:approve");
        if (!ctx) return;
        const result = await approveFirmMemoryCandidate(ctx.db, {
            firmId: ctx.firmId,
            candidateId: req.params.id,
            reviewerUserId: ctx.userId,
        });
        if (!result.ok) {
            return res
                .status(409)
                .json({ error: result.reason ?? "candidate is not pending" });
        }
        // Best-effort audit; the approval already committed, so never fail it
        // on a ledger hiccup.
        try {
            await createAgentOperation({
                db: ctx.db,
                userId: ctx.userId,
                orgId: ctx.orgId,
                toolName: "approve_firm_memory",
                actionType: "firm_memory_approve",
                mutating: true,
                requiresApproval: false,
                approvalStatus: "approved",
                arguments: { candidate_id: req.params.id },
                metadata: {
                    candidate_id: req.params.id,
                    version: result.version,
                    key: result.candidate?.proposed_key ?? null,
                },
            });
        } catch (e) {
            console.error("[firm-memory] approval ledger write failed", e);
        }
        res.json({ ok: true, version: result.version });
    }),
);

// POST /firm-memory/candidates/:id/reject — admin rejects (status-guarded).
firmMemoryRouter.post(
    "/candidates/:id/reject",
    asyncRoute(async (req, res) => {
        const ctx = await authorizeFirm(res, "operation:approve");
        if (!ctx) return;
        const note =
            typeof (req.body as Record<string, unknown> | undefined)?.note ===
            "string"
                ? ((req.body as Record<string, unknown>).note as string)
                : undefined;
        const result = await rejectFirmMemoryCandidate(ctx.db, {
            firmId: ctx.firmId,
            candidateId: req.params.id,
            reviewerUserId: ctx.userId,
            note,
        });
        if (!result.ok) {
            return res
                .status(409)
                .json({ error: result.reason ?? "candidate is not pending" });
        }
        res.json({ ok: true });
    }),
);

firmMemoryRouter.use(
    (err: unknown, _req: Request, res: Response, next: NextFunction) => {
        if (res.headersSent) return next(err);
        console.error("[firm-memory] unhandled route error", err);
        res.status(500).json({ error: "Failed to process firm-memory request" });
    },
);
