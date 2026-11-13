import {
    getDocumentGenerationStatus,
    retryDocumentGeneration,
    DocumentJobAccessError,
} from "../lib/documentGeneration/status";
import {
    Router,
    type NextFunction,
    type Request,
    type Response,
} from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
    getDocumentGenerationJob,
    requestDocumentGenerationCancel,
} from "../lib/documentGeneration/store";
import { wakeDocumentGenerationWorker } from "../lib/documentGeneration/worker";
import { checkProjectAccess } from "../lib/access";

export const documentGenerationRouter = Router();
documentGenerationRouter.use(requireAuth);

type AsyncRoute = (req: Request, res: Response) => Promise<unknown>;
function asyncRoute(handler: AsyncRoute) {
    return (req: Request, res: Response, next: NextFunction) => {
        void handler(req, res).catch(next);
    };
}

documentGenerationRouter.get(
    "/:jobId",
    asyncRoute(async (req, res) => {
        try {
            return res.json(
                await getDocumentGenerationStatus(
                    createServerSupabase(),
                    req.params.jobId,
                    {
                        userId: res.locals.userId,
                        userEmail: res.locals.userEmail,
                    },
                ),
            );
        } catch (error) {
            if (error instanceof DocumentJobAccessError)
                return res.status(404).json({ detail: "Job not found" });
            throw error;
        }
    }),
);

documentGenerationRouter.post(
    "/:jobId/retry-failed",
    asyncRoute(async (req, res) => {
        const db = createServerSupabase();
        const scope = {
            userId: res.locals.userId as string,
            userEmail: res.locals.userEmail as string,
        };
        try {
            const result = await retryDocumentGeneration(
                db,
                req.params.jobId,
                scope,
            );
            if (result.outcome !== "requeued")
                return res.status(409).json({
                    detail: "This packet has no failed documents that can be retried.",
                });
            wakeDocumentGenerationWorker();
            const job = await getDocumentGenerationStatus(
                db,
                req.params.jobId,
                scope,
            );
            return res.status(202).json({
                id: job.id,
                status: job.status,
                requeued_items: result.requeued_items,
                completed_items: job.completed_items,
                failed_items: job.failed_items,
            });
        } catch (error) {
            if (error instanceof DocumentJobAccessError)
                return res.status(404).json({ detail: "Job not found" });
            throw error;
        }
    }),
);

documentGenerationRouter.post(
    "/:jobId/cancel",
    asyncRoute(async (req, res) => {
        const userId = res.locals.userId as string | undefined;
        const userEmail = res.locals.userEmail as string | undefined;
        if (!userId) return res.status(401).json({ detail: "unauthorized" });
        const db = createServerSupabase();
        const { job } = await getDocumentGenerationJob(db, req.params.jobId);
        const canCancel = job?.project_id
            ? (
                  await checkProjectAccess(
                      job.project_id,
                      userId,
                      userEmail,
                      db,
                      "mutate",
                  )
              ).ok
            : job?.user_id === userId;
        if (!job || !canCancel) {
            return res.status(404).json({ detail: "Job not found" });
        }
        const accepted = await requestDocumentGenerationCancel(
            db,
            req.params.jobId,
        );
        wakeDocumentGenerationWorker();
        return res.status(accepted ? 202 : 200).json({
            id: req.params.jobId,
            cancellation_requested: accepted || !!job.cancel_requested_at,
            status: job.status,
        });
    }),
);
