import { Readable } from "node:stream";
import { Router } from "express";

import { requireInternal } from "../middleware/internal";
import { getShareItems } from "../modules/internal/share.service";
import { getFeedDiamondsPage } from "../modules/internal/feed.service";
import { resolveCertUrl } from "../modules/internal/cert.service";
import { resolveGemstoneImage2Url } from "../modules/internal/gem-image.service";

export const internalRouter = Router();

internalRouter.use(requireInternal);

internalRouter.get("/share", async (req, res) => {
  const raw = typeof req.query.ids === "string" ? req.query.ids : "";
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const items = await getShareItems(ids);
  res.json({ items });
});

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

internalRouter.get("/gemstone-image/:id", async (req, res) => {
  const imageUrl = await resolveGemstoneImage2Url(req.params.id);
  if (!imageUrl || !isFetchableUrl(imageUrl)) {
    res.status(404).send("Image not found");
    return;
  }

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(imageUrl, { redirect: "follow" });
  } catch {
    res.status(502).send("Image unavailable");
    return;
  }
  if (!upstream.ok || !upstream.body) {
    res.status(502).send("Image unavailable");
    return;
  }

  res.status(200);
  res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/octet-stream");
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=86400");
  Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
});
