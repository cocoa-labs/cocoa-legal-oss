import crypto from "node:crypto";
import type { RequestHandler } from "express";
import { createServerSupabase } from "./supabase";
import { resolveAuthenticatedRequest } from "../middleware/auth";

function publicSignerToken(req: Parameters<RequestHandler>[0]): string {
  const param = typeof req.params?.token === "string" ? req.params.token : "";
  if (param) return param;
  const pathname = (req.originalUrl || `${req.baseUrl}${req.path}`).split("?", 1)[0];
  return pathname.match(/^\/sign\/([^/]+)/)?.[1] ?? "";
}

function identityHash(req: Parameters<RequestHandler>[0], userId?: string): string {
  const signerToken = publicSignerToken(req);
  const source = userId
    ? `user:${userId}`
    : signerToken
      ? `signer:${signerToken}|ip:${req.ip ?? "unknown"}`
      : `anonymous:${req.ip ?? "unknown"}`;
  return crypto.createHash("sha256").update(source).digest("hex").slice(0, 32);
}

function routeKey(req: Parameters<RequestHandler>[0]): string {
  const pathname = (req.originalUrl || `${req.baseUrl}${req.path}`).split("?", 1)[0];
  return pathname
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id")
    .replace(/^\/sign\/[^/]+/, "/sign/:token")
    .slice(0, 160);
}

export function makeDistributedLimiter(options: {
  name: string;
  windowMs: number;
  max: number;
  message?: string;
}): RequestHandler {
  return async (req, res, next) => {
    if (req.method === "OPTIONS") return next();
    if (options.name === "general" && req.path.startsWith("/health")) return next();
    const windowSeconds = Math.max(1, Math.ceil(options.windowMs / 1_000));
    const windowSlot = Math.floor(Date.now() / options.windowMs);
    const identity = req.headers.authorization?.startsWith("Bearer ")
      ? await resolveAuthenticatedRequest(req, res)
      : null;
    const bucketKey = `${options.name}:${req.method}:${routeKey(req)}:${identityHash(req, identity?.userId)}:${windowSlot}`;
    const { data, error } = await createServerSupabase().rpc("consume_rate_limit", {
      p_bucket_key: bucketKey,
      p_window_seconds: windowSeconds,
      p_max_requests: options.max,
    });
    if (error) {
      return void res.status(503).json({
        code: "RATE_LIMIT_UNAVAILABLE",
        detail: "Request protection is temporarily unavailable. Please retry shortly.",
      });
    }
    const result = Array.isArray(data) ? data[0] : data;
    const resetAt = result?.reset_at ? new Date(result.reset_at) : new Date(Date.now() + options.windowMs);
    const retryAfter = Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1_000));
    res.setHeader("RateLimit-Limit", String(options.max));
    res.setHeader("RateLimit-Remaining", String(result?.remaining ?? 0));
    res.setHeader("RateLimit-Reset", String(Math.ceil(resetAt.getTime() / 1_000)));
    if (!result?.allowed) {
      res.setHeader("Retry-After", String(retryAfter));
      return void res.status(429).json({
        code: "RATE_LIMITED",
        detail: options.message ?? "Too many requests. Please try again later.",
        retry_after_seconds: retryAfter,
      });
    }
    next();
  };
}
