import { Request, Response, NextFunction } from "express";
import { createClient } from "@supabase/supabase-js";

export type AuthenticatedRequestIdentity = {
  userId: string;
  userEmail: string;
  token: string;
};

export async function resolveAuthenticatedRequest(
  req: Request,
  res: Response,
): Promise<AuthenticatedRequestIdentity | null> {
  if (typeof res.locals.userId === "string" && res.locals.userId) {
    return {
      userId: res.locals.userId,
      userEmail: String(res.locals.userEmail ?? ""),
      token: String(res.locals.token ?? ""),
    };
  }
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;

  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SECRET_KEY ?? "";
  if (!supabaseUrl || !serviceKey) return null;

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const { data } = await admin.auth.getUser(token);
  if (!data.user) return null;
  const identity = {
    userId: data.user.id,
    userEmail: data.user.email?.toLowerCase() ?? "",
    token,
  };
  res.locals.userId = identity.userId;
  res.locals.userEmail = identity.userEmail;
  res.locals.token = identity.token;
  return identity;
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) {
    res.status(401).json({ detail: "Missing or invalid Authorization header" });
    return;
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    res.status(500).json({ detail: "Server auth is not configured" });
    return;
  }
  const identity = await resolveAuthenticatedRequest(req, res);
  if (!identity) {
    res.status(401).json({ detail: "Invalid or expired token" });
    return;
  }
  next();
}
