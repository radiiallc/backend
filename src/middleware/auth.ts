import type { Request, Response, NextFunction } from "express";

import { SESSION_COOKIE, verifySession, type SessionUser } from "../modules/auth/session";

// Augment Express Request with the authenticated user (the app-layer authz the
// MVP enforced server-side; RLS is intentionally not used — ADR 2026-06-17).
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

// Populate req.user from the session cookie if present (never rejects).
export async function attachUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = (req.cookies?.[SESSION_COOKIE] as string | undefined) ?? undefined;
  req.user = (await verifySession(token)) ?? undefined;
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  if (req.user.role !== "ADMIN") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}

// requireStaff: ADMIN today; widens to include the STAFF role once H1 adds it.
export function requireStaff(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const role = req.user.role as string;
  if (role !== "ADMIN" && role !== "STAFF") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}
