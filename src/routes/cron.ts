import { Router, type Request } from "express";

import { env } from "../env";
import { runUnifiedIngest } from "../integrations/inventory/diamond-ingest";

export const cronRouter = Router();

// Gate §6 — cron auth never falls open: empty/missing CRON_SECRET => 401, not 200.
// Accepts `Authorization: Bearer <secret>` or `?secret=<secret>` (ported verbatim
// from the portal cron route).
function authorized(req: Request): boolean {
  const secret = env.cronSecret;
  if (!secret) return false;
  const header = req.headers.authorization ?? "";
  if (header === `Bearer ${secret}`) return true;
  return req.query.secret === secret;
}

async function handle(req: Request, res: import("express").Response): Promise<void> {
  if (!authorized(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const result = await runUnifiedIngest();
  res.status(result.status === "error" ? 500 : 200).json(result);
}

// Unified RapNet ingest (all 3 feeds). `/gemstones` is the legacy alias.
cronRouter.get("/ingest/diamonds", handle);
cronRouter.post("/ingest/diamonds", handle);
cronRouter.get("/ingest/gemstones", handle);
cronRouter.post("/ingest/gemstones", handle);
