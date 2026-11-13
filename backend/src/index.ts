import { startEmailAttachmentWorker } from "./lib/email/attachmentWorker";
import "./lib/loadEnv";
import { installStructuredConsole } from "./lib/logger";
import { captureException, initTelemetry, Sentry } from "./lib/telemetry";
// Populate the legal-capability registry before any router module reads
// it. Side-effect-only import: each capability self-registers at load.
import "./lib/legalCapabilities/register";
import crypto from "node:crypto";
import express from "express";
// Express 4 drops async handler rejections on the floor — one rejected
// promise in any route used to kill the whole process. This import
// monkey-patches the Router so those rejections reach next() and land in
// the error middleware below. Must run before any router module loads.
import "express-async-errors";
import cors from "cors";
import helmet from "helmet";
import { chatRouter } from "./routes/chat";
import { projectsRouter } from "./routes/projects";
import { projectTasksRouter } from "./routes/projectTasks";
import { projectChatRouter } from "./routes/projectChat";
import { documentsRouter } from "./routes/documents";
import { tabularRouter } from "./routes/tabular";
import { workflowsRouter } from "./routes/workflows";
import { playbooksRouter } from "./routes/playbooks";
import { firmMemoryRouter } from "./routes/firmMemory";
import { templatesRouter } from "./routes/templates";
import { userRouter } from "./routes/user";
import { modelsRouter } from "./routes/models";
import { warmOpenRouterCatalog } from "./lib/llm";
import { downloadsRouter } from "./routes/downloads";
import { operationsRouter } from "./routes/operations";
import { chatAttachmentsRouter } from "./routes/chatAttachments";
import { emailRouter, inboundRouter } from "./routes/email";
import { signaturesRouter, signRouter } from "./routes/signatures";
import { casesRouter } from "./routes/cases";
import { automationRouter } from "./routes/automation";
import { recordingsRouter } from "./routes/recordings";
import { calendarRouter } from "./routes/calendar";
import { documentGenerationRouter } from "./routes/documentGeneration";
import {
  checkDatabaseSchema,
  checkMigrationDirectory,
  EXPECTED_SCHEMA_VERSION,
} from "./lib/migrations";
import { envInt } from "./lib/concurrency";
import { makeDistributedLimiter } from "./lib/distributedRateLimit";
import { validateCriticalEnv } from "./lib/envValidation";
import { checkSigningIdentityAtBoot } from "./lib/signatures/cert";
import { createServerSupabase } from "./lib/supabase";
import { checkStorageReachable } from "./lib/storage";
import {
  checkLibreOfficeReachable,
  getLibreOfficeVersion,
} from "./lib/libreoffice";
import {
  getDocumentGenerationCanaryState,
  runDocumentGenerationCanary,
} from "./lib/documentGeneration/canary";
import { startAutomationScheduler } from "./lib/automation/scheduler";
import { startRecordingsScheduler } from "./lib/recordings/scheduler";
import { startCalendarReminderScheduler } from "./lib/calendar/reminderScheduler";
import { startDocumentGenerationScheduler } from "./lib/documentGeneration/worker";
import { checkClamAvReachable } from "./lib/upload";
import { startLifecyclePurgeWorker } from "./lib/workers/purge";
import { startMatterTaskReconciliationWorker } from "./lib/workers/taskReconciliation";
import { startConversationSummaryScheduler } from "./lib/conversationSummary/worker";
import { startModelConformanceWorker } from "./lib/workers/modelConformance";

const app = express();
const PORT = process.env.PORT ?? 3001;
const isProduction = process.env.NODE_ENV === "production";
installStructuredConsole();
initTelemetry();
checkMigrationDirectory();

// Fail fast on missing critical env. A production process that boots without
// its Supabase/R2/download-signing config only discovers the hole on the
// first request that needs it — a user-facing 500 instead of a refused
// deploy. Dev stays bootable with no env at all.
const envCheck = validateCriticalEnv(process.env, isProduction);
for (const warning of envCheck.warnings) {
  console.warn(`[startup] ${warning}`);
}
if (envCheck.fatal) {
  for (const name of envCheck.missing) {
    console.error(`[startup] missing required env var: ${name}`);
  }
  process.exit(1);
} else if (envCheck.missing.length > 0) {
  console.warn(
    "[startup] missing env vars (dependent features will fail at request " +
      `time): ${envCheck.missing.join(", ")}`,
  );
}

// Validate the e-signature signing identity before serving. A SET-but-broken
// SIGNING_CERT_P12_BASE64 must fail the deploy here — in dev too — rather than
// silently falling back to the ephemeral cert or 500ing mid-envelope-completion
// inside P12Signer. An unset cert stays bootable (dev norm; production gets an
// envValidation warning above).
const signingCheck = checkSigningIdentityAtBoot();
if (!signingCheck.ok) {
  console.error(`[startup] signing identity unusable: ${signingCheck.error}`);
  process.exit(1);
}
console.log(`[startup] ${signingCheck.logLine}`);
for (const warning of signingCheck.warnings) {
  console.warn(`[startup] ${warning}`);
}

const DEV_ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  "http://localhost:3003",
  "http://localhost:3004",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3003",
];

function minutes(value: number): number {
  return value * 60 * 1000;
}

function hours(value: number): number {
  return minutes(value * 60);
}

function makeLimiter(options: {
  name: string;
  windowMs: number;
  max: number;
  message?: string;
}) {
  return makeDistributedLimiter(options);
}

function allowedOrigins(): string[] {
  const configured = [process.env.FRONTEND_URL, process.env.CORS_ORIGINS]
    .filter((value): value is string => !!value)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const origins = isProduction
    ? configured
    : [...configured, ...DEV_ALLOWED_ORIGINS];
  return [...new Set(origins)];
}

// 300/15min/IP was too tight for an interactive document SPA — a single page
// load fires many small requests, and multiple users behind one office NAT
// share this per-IP budget. The accept-tracked-change refresh fan-out (now
// coalesced client-side) used to blow through it and surface as HTTP 429.
const generalLimiter = makeLimiter({
  name: "general",
  windowMs: minutes(envInt("RATE_LIMIT_GENERAL_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_GENERAL_MAX", 1000),
});

const chatLimiter = makeLimiter({
  name: "chat",
  windowMs: minutes(envInt("RATE_LIMIT_CHAT_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_CHAT_MAX", 30),
  message: "Too many chat requests. Please try again later.",
});

const chatCreateLimiter = makeLimiter({
  name: "chat-create",
  windowMs: minutes(envInt("RATE_LIMIT_CHAT_CREATE_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_CHAT_CREATE_MAX", 60),
});

const uploadLimiter = makeLimiter({
  name: "upload",
  windowMs: hours(envInt("RATE_LIMIT_UPLOAD_WINDOW_HOURS", 1)),
  max: envInt("RATE_LIMIT_UPLOAD_MAX", 50),
  message: "Too many upload requests. Please try again later.",
});

// Public, token-gated signer endpoints (no auth session). Keep a tighter
// limit than general traffic since these are reachable by anyone with a link.
const signLimiter = makeLimiter({
  name: "sign",
  windowMs: minutes(envInt("RATE_LIMIT_SIGN_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_SIGN_MAX", 60),
  message: "Too many signing requests. Please try again later.",
});

app.disable("x-powered-by");
app.set("trust proxy", envInt("TRUST_PROXY_HOPS", 1));

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    hsts: isProduction
      ? {
          maxAge: 15552000,
          includeSubDomains: true,
        }
      : false,
    referrerPolicy: { policy: "no-referrer" },
  }),
);

app.use(
  cors({
    origin: (origin, callback) => {
      const allowed = allowedOrigins();
      if (!origin) return callback(null, true);
      if (allowed.includes(origin)) return callback(null, true);
      return callback(new Error("CORS origin is not allowed"));
    },
    credentials: true,
  }),
);

app.use(generalLimiter);

app.use((req, res, next) => {
  const requestId =
    typeof req.headers["x-request-id"] === "string"
      ? req.headers["x-request-id"]
      : crypto.randomUUID();
  res.setHeader("x-request-id", requestId);
  const started = Date.now();
  res.on("finish", () => {
    console.log("[request]", {
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - started,
    });
  });
  next();
});

// JSON body limits. This used to be a blanket 50mb, which let any
// unauthenticated endpoint buffer 50MB of JSON per request. File bytes never
// travel as JSON — every document/image upload is multer multipart (see
// lib/upload.ts; /single-documents, /projects/:id/documents,
// /chat-attachments/images) — so the default is 1mb, and only routers with
// concrete evidence of larger JSON payloads get a raised limit. The raised
// mounts MUST come before the global parser: body-parser marks a parsed
// request (req._body) and later parsers skip it, so the most specific mount
// wins. A 413 from a too-small limit is user-facing breakage, so each raised
// limit is generous relative to its evidence.

// Drawn-signature data URLs ride JSON: the public signer POST /sign/:token
// (frontend/src/app/sign/lib/signApi.ts → SignSubmitPayload.signature_png)
// and the authed POST /signatures/:id/sign-self (cocoLegalApi.ts →
// SignSelfPayload.signature_png). A high-DPI canvas PNG as a base64 data URL
// is typically well under 1mb, but a 413 here would eat a signer's completed
// signature — 10mb leaves wide margin.
app.use(["/sign", "/signatures"], express.json({ limit: "10mb" }));

// Chat endpoints resend the full message history every turn, and users paste
// entire contracts into messages (streamChat / streamProjectChat / the
// tabular chat in cocoLegalApi.ts — under /chat, /projects/:id/chat and
// /tabular-review/:id/chat). Long matters can plausibly exceed 1mb of text.
app.use(
  ["/chat", "/projects", "/tabular-review"],
  express.json({ limit: "5mb" }),
);

// Firm template authoring POSTs the entire section skeleton as JSON
// (createTemplate in cocoLegalApi.ts → skeleton: DocTemplateSection[]); a long
// lease template is hundreds of KB of text.
app.use("/templates", express.json({ limit: "5mb" }));

// Everything else: small control-plane JSON (ids, flags, short strings).
app.use(express.json({ limit: "1mb" }));

app.post("/chat", chatLimiter);
app.post("/projects/:projectId/chat", chatLimiter);
app.post("/tabular-review/:reviewId/chat", chatLimiter);
app.post("/tabular-review/:reviewId/generate", chatLimiter);
// Recordings on-demand generators invoke paid OpenAI TTS / image APIs — limit
// them like the other generate endpoints. email-draft can auto-generate the
// timeline image (a paid image call), so it is gated too.
app.post("/recordings/:id/voice-briefing", chatLimiter);
app.post("/recordings/:id/timeline-image", chatLimiter);
app.post("/recordings/:id/email-draft", chatLimiter);
app.post("/chat/create", chatCreateLimiter);
app.post("/chat/:chatId/generate-title", chatCreateLimiter);
app.post("/single-documents", uploadLimiter);
app.post("/single-documents/:documentId/versions", uploadLimiter);
app.post("/projects/:projectId/documents", uploadLimiter);
app.post("/chat-attachments/images", uploadLimiter);
app.post("/cases/import", uploadLimiter);
app.post("/recordings", uploadLimiter);

app.use("/chat", chatRouter);
app.use("/projects/:projectId/tasks", projectTasksRouter);
app.use("/projects", projectsRouter);
app.use("/projects/:projectId/chat", projectChatRouter);
app.use("/single-documents", documentsRouter);
app.use("/chat-attachments", chatAttachmentsRouter);
app.use("/tabular-review", tabularRouter);
app.use("/workflows", workflowsRouter);
app.use("/playbooks", playbooksRouter);
app.use("/firm-memory", firmMemoryRouter);
app.use("/templates", templatesRouter);
app.use("/user", userRouter);
app.use("/users", userRouter);
app.use("/models", modelsRouter);
app.use("/download", downloadsRouter);
app.use("/operations", operationsRouter);
app.use("/email", emailRouter);
app.use("/email-inbound", inboundRouter);
app.use("/cases", casesRouter);
app.use("/automation", automationRouter);
app.use("/recordings", recordingsRouter);
app.use("/calendar", calendarRouter);
app.use("/document-generation-jobs", documentGenerationRouter);
app.use("/signatures", signaturesRouter);
app.use("/sign", signLimiter, signRouter);

const deploymentId =
  process.env.DEPLOYMENT_ID ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? "local";
app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    deployment_id: deploymentId,
    schema_expected: EXPECTED_SCHEMA_VERSION,
  }),
);

// Liveness (/health) and readiness are deliberately separate: /health says
// "the process is up" so the host doesn't restart-loop us while a
// dependency is down; /health/ready says "this instance can serve real
// traffic" so load balancers stop routing to it when Supabase or R2 is out.
const READY_CHECK_TIMEOUT_MS = 2000;

async function readyCheck(
  probe: () => Promise<void>,
): Promise<"ok" | "failed"> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("readiness check timed out")),
          READY_CHECK_TIMEOUT_MS,
        );
      }),
    ]);
    return "ok";
  } catch {
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}

app.get("/health/ready", async (_req, res) => {
  const documentGenerationState = getDocumentGenerationCanaryState();
  const documentGeneration =
    documentGenerationState.status === "passed"
      ? "ok"
      : documentGenerationState.status === "failed"
        ? "failed"
        : "pending";
  const [supabase, storage, libreoffice, schema, scanner] = await Promise.all([
    // Cheap real query: proves URL, key, and the database are all good —
    // a HEAD on the REST root would pass with a revoked service key.
    readyCheck(async () => {
      const { error } = await createServerSupabase()
        .from("user_profiles")
        .select("id")
        .limit(1);
      if (error) throw new Error(error.message);
    }),
    readyCheck(() => checkStorageReachable()),
    readyCheck(() => checkLibreOfficeReachable()),
    readyCheck(() => checkDatabaseSchema(createServerSupabase())),
    process.env.CLAMAV_HOST
      ? readyCheck(() => checkClamAvReachable())
      : Promise.resolve("disabled" as const),
  ]);
  const ok =
    supabase === "ok" &&
    storage === "ok" &&
    libreoffice === "ok" &&
    schema === "ok" &&
    documentGeneration === "ok";
  res.status(ok ? 200 : 503).json({
    ok,
    deployment_id: deploymentId,
    degraded:
      scanner !== "ok" &&
      ((process.env.BETA_MODE ?? "").toLowerCase() === "true" ||
        (process.env.UPLOAD_SCANNING_REQUIRED ?? "").toLowerCase() === "true"),
    capabilities: {
      uploads:
        scanner === "ok" ||
        !(
          (process.env.BETA_MODE ?? "").toLowerCase() === "true" ||
          (process.env.UPLOAD_SCANNING_REQUIRED ?? "").toLowerCase() === "true"
        ),
      document_generation: documentGeneration === "ok",
    },
    checks: {
      supabase,
      storage,
      libreoffice,
      schema,
      scanner,
      document_generation: documentGeneration,
    },
    document_generation: documentGenerationState,
  });
});

if (process.env.SENTRY_DSN) Sentry.setupExpressErrorHandler(app);

// Last-resort error handler — async rejections arrive here via the
// express-async-errors patch above. The 4-arg signature is what Express
// keys on; keep it even though `next` is unused.
app.use(
  (
    err: unknown,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const stack =
      err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error("[error]", {
      method: req.method,
      path: req.path,
      requestId: res.getHeader("x-request-id"),
      stack,
    });
    captureException(err, {
      requestId: String(res.getHeader("x-request-id") ?? ""),
      method: req.method,
    });
    // A body over one of the express.json limits above used to surface as a
    // generic 500, which made an over-limit payload indistinguishable from a
    // crash. Surface it as the 413 it is so the client (and our logs) can
    // tell "request too big" from "server broke".
    if (
      !res.headersSent &&
      typeof err === "object" &&
      err !== null &&
      (err as { type?: unknown }).type === "entity.too.large"
    ) {
      return void res.status(413).json({
        detail: "Request body is too large for this endpoint.",
      });
    }
    if (!res.headersSent) {
      res.status(500).json({ detail: "Internal server error" });
    } else {
      // Mid-stream failure (SSE already flushed headers): nothing valid
      // left to send — just close the connection.
      res.end();
    }
  },
);

// A stray rejected promise (outside any request) must not take the
// process down — that severs every live SSE session. Log loudly instead.
process.on("unhandledRejection", (reason) => {
  const stack =
    reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  console.error("[unhandledRejection]", stack);
  captureException(reason, { kind: "unhandledRejection" });
});

// An uncaught synchronous throw leaves state we can't trust (half-written
// documents, dangling locks). Log and exit — the host restarts the process.
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err.stack ?? String(err));
  captureException(err, { kind: "uncaughtException" });
  process.exit(1);
});

app.listen(PORT, () => {
  console.log(`Coco Legal backend running on port ${PORT}`);
  // Pull the OpenRouter catalog once at boot so the first picker load is warm.
  // Fire-and-forget by design: it never rejects, and every native provider
  // path works whether or not it ever succeeds.
  warmOpenRouterCatalog();
  // The drafting worker is deliberately started only after the real Quill
  // DOCX -> LibreOffice -> layout-QA path passes. Presence of the binary alone
  // is not readiness, and readiness probes only read the cached canary state.
  void (async () => {
    try {
      const runtime = await getLibreOfficeVersion();
      console.log("[startup] LibreOffice binary found", runtime);
    } catch (error) {
      console.error("[startup] LibreOffice unavailable", {
        code:
          error && typeof error === "object" && "code" in error
            ? error.code
            : "DOCUMENT_CONVERTER_UNAVAILABLE",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const canary = await runDocumentGenerationCanary();
    if (canary.status === "passed") {
      console.log("[startup] document-generation canary passed", {
        rendererMode: canary.renderer_mode,
        ms: canary.duration_ms,
      });
      startDocumentGenerationScheduler();
    } else {
      console.error(
        "[startup] document-generation canary FAILED — drafting worker will not claim jobs",
        {
          failureCode: canary.failure_code,
          ms: canary.duration_ms,
          error: canary.error,
        },
      );
    }
  })();
  // PI email-automation scheduler: a hard no-op unless AUTOMATION_ENABLED=true,
  // and it degrades to a logged no-op (never a crash loop) when Supabase is
  // unconfigured or the 023 automation tables are not applied yet.
  startAutomationScheduler();
  startEmailAttachmentWorker();
  // Recordings transcription scheduler: a hard no-op unless ASSEMBLYAI_API_KEY
  // and object storage (R2) are both configured, and it degrades to a logged
  // no-op (never a crash loop) when Supabase or the 025 tables are unavailable.
  startRecordingsScheduler();
  // Calendar deadline-reminder scheduler: a hard no-op unless
  // CALENDAR_REMINDER_WORKER_ENABLED=true, and it degrades to a logged no-op
  // (never a crash loop) when Supabase or the 026 calendar tables are missing.
  startCalendarReminderScheduler();
  startConversationSummaryScheduler();
  startModelConformanceWorker();
  startMatterTaskReconciliationWorker();
  startLifecyclePurgeWorker();
});
