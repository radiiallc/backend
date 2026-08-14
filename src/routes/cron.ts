import { Router, type Request } from "express";

import { env } from "../env";
import { runUnifiedIngest } from "../integrations/inventory/diamond-ingest";

export const cronRouter = Router();

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

cronRouter.get("/ingest/diamonds", handle);
cronRouter.post("/ingest/diamonds", handle);
cronRouter.get("/ingest/gemstones", handle);
cronRouter.post("/ingest/gemstones", handle);
