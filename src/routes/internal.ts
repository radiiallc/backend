import { Readable } from "node:stream";
import { Router } from "express";

import { requireInternal } from "../middleware/internal";
import { getShareItems } from "../modules/internal/share.service";
import { getFeedDiamondsPage } from "../modules/internal/feed.service";
import { resolveCertUrl } from "../modules/internal/cert.service";

// Service-to-service surface for the portal's session-less public/feed/proxy
// routes. Gated by the shared INTERNAL_API_SECRET (requireInternal). Never
// returns vendor certUrl: the cert endpoint streams the file; feed rows expose
// only `hasCert` (Gate §8).
export const internalRouter = Router();

internalRouter.use(requireInternal);

// GET /internal/share?ids=a,b,c — stones for the public share selection page.
internalRouter.get("/share", async (req, res) => {
  const raw = typeof req.query.ids === "string" ? req.query.ids : "";
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const items = await getShareItems(ids);
  res.json({ items });
});

// GET /internal/feed/diamonds?cursor=&limit= — one cursor page of Sherry feed rows.
internalRouter.get("/feed/diamonds", async (req, res) => {
  const cursor = typeof req.query.cursor === "string" && req.query.cursor ? req.query.cursor : undefined;
  const limit = Number(req.query.limit) || 0;
  const page = await getFeedDiamondsPage(cursor, limit);
  res.json(page);
});

function isFetchableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

// GET /internal/certificate/:type/:id — resolves the vendor cert URL server-side,
// fetches it, and streams the file back. The URL itself is never returned.
internalRouter.get("/certificate/:type/:id", async (req, res) => {
  const certUrl = await resolveCertUrl(req.params.type, req.params.id);
  if (!certUrl || !isFetchableUrl(certUrl)) {
    res.status(404).send("Certificate not found");
    return;
  }

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(certUrl, { redirect: "follow" });
  } catch {
    res.status(502).send("Certificate unavailable");
    return;
  }
  if (!upstream.ok || !upstream.body) {
    res.status(502).send("Certificate unavailable");
    return;
  }

  res.status(200);
  res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/octet-stream");
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=86400");
  Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
});
