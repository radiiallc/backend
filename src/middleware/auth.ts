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

// requireAdmin: the ADMIN-only gate. Use for Settings + user management (spec
// §12) — staff are deliberately blocked from these even in the IMS.
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

// requireStaff: the IMS gate — allows ADMIN or STAFF. STAFF is live as of H1
// (added to the UserRole enum + SessionUser). Every IMS API route (inventory,
// documents, clients, vendors, reports — H3+) mounts this; the ADMIN-only
// surfaces use requireAdmin instead.
export function requireStaff(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  if (req.user.role !== "ADMIN" && req.user.role !== "STAFF") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}
