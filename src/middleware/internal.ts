import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

import { env } from "../env";

// Gate for the service-to-service /internal surface. These routes are called only
// by the portal server (share page, Sherry feed, cert proxy) with the shared
// INTERNAL_API_SECRET in `x-internal-secret` — never by a browser. Fails closed
// when the secret is unset, and compares in constant time.
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
