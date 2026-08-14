import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

import { env } from "../env";

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function requireInternal(req: Request, res: Response, next: NextFunction): void {
  const expected = env.internalApiSecret;
  if (!expected) {
    res.status(401).json({ error: "internal api disabled" });
    return;
  }
  const provided = (req.headers["x-internal-secret"] as string | undefined) ?? "";
  if (!constantTimeEquals(provided, expected)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}
