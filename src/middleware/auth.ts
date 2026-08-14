import type { Request, Response, NextFunction } from "express";

import { SESSION_COOKIE, verifySession, type SessionUser } from "../modules/auth/session";

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

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
