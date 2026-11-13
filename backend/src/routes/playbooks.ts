import { Router, type NextFunction, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
    resolveFirmId,
    getPlaybookEntry,
    setPlaybookEntry,
    listPlaybookEntries,
    deletePlaybookEntry,
} from "../lib/playbooks";

export const playbooksRouter = Router();

type AsyncRoute = (req: Request, res: Response) => Promise<unknown>;
function asyncRoute(handler: AsyncRoute) {
    return (req: Request, res: Response, next: NextFunction) => {
        void handler(req, res).catch(next);
    };
}

playbooksRouter.use(requireAuth);

// GET /playbooks/entries — list all entries for the caller's firm
playbooksRouter.get(
    "/entries",
    asyncRoute(async (req, res) => {
        const userId = res.locals.userId as string | undefined;
        if (!userId) return res.status(401).json({ error: "unauthorized" });
        const db = createServerSupabase();
        const firmId = await resolveFirmId(userId);
        const entries = await listPlaybookEntries(db, firmId);
        res.json({ entries });
    }),
);

// GET /playbooks/entries/:key — fetch one entry
playbooksRouter.get(
    "/entries/:key",
    asyncRoute(async (req, res) => {
        const userId = res.locals.userId as string | undefined;
        if (!userId) return res.status(401).json({ error: "unauthorized" });
        const db = createServerSupabase();
        const firmId = await resolveFirmId(userId);
        const entry = await getPlaybookEntry(db, firmId, req.params.key);
        if (!entry) return res.status(404).json({ error: "not found" });
        res.json({ entry });
    }),
);

// PUT /playbooks/entries/:key — upsert
playbooksRouter.put(
    "/entries/:key",
    asyncRoute(async (req, res) => {
        const userId = res.locals.userId as string | undefined;
        if (!userId) return res.status(401).json({ error: "unauthorized" });
        const { value, notes_md } = (req.body as Record<string, unknown>) ?? {};
        if (value === undefined) {
            return res.status(400).json({ error: "value is required" });
        }
        const db = createServerSupabase();
        const firmId = await resolveFirmId(userId);
        await setPlaybookEntry(db, firmId, req.params.key, {
            value,
            notes_md: typeof notes_md === "string" ? notes_md : undefined,
        });
        const entry = await getPlaybookEntry(db, firmId, req.params.key);
        res.json({ entry });
    }),
);

// DELETE /playbooks/entries/:key — remove an entry
playbooksRouter.delete(
    "/entries/:key",
    asyncRoute(async (req, res) => {
        const userId = res.locals.userId as string | undefined;
        if (!userId) return res.status(401).json({ error: "unauthorized" });
        const db = createServerSupabase();
        const firmId = await resolveFirmId(userId);
        await deletePlaybookEntry(db, firmId, req.params.key);
        res.status(204).end();
    }),
);

playbooksRouter.use(
    (err: unknown, _req: Request, res: Response, next: NextFunction) => {
        if (res.headersSent) return next(err);
        console.error("[playbooks] unhandled route error", err);
        res.status(500).json({ error: "Failed to process playbook request" });
    },
);
