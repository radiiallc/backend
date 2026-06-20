import { Router, type Request, type Response } from "express";

import {
  DiamondOriginSchema,
  parseDiamondSearchParams,
  parseGemstoneSearchParams
} from "@/contract";

import { requireAuth } from "../middleware/auth";
import {
  countDiamonds,
  getDiamondFilterBounds,
  searchDiamonds
} from "../modules/catalog/diamond-search.service";
import {
  countGemstones,
  getGemstoneFilterBounds,
  searchGemstones
} from "../modules/catalog/gemstone-search.service";
import {
  getDiamondByIdForBuyer,
  getGemstoneByIdForBuyer,
  getInventoryCounts
} from "../modules/catalog/reads.service";

export const catalogRouter = Router();

// Catalog reads mirror the portal's authed buyer pages: companyId comes from the
// session (markup is applied per company; null company => base prices). All routes
// require an authenticated user, matching the pre-split middleware that redirected
// anonymous visitors away from catalog pages.
catalogRouter.use(requireAuth);

// Express 4 doesn't catch async handler rejections — wrap so they 500 cleanly.
function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    handler(req, res).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[catalog] handler error", err);
      if (!res.headersSent) res.status(500).json({ error: "Internal error" });
    });
  };
}

// Express req.query is ParsedQs; the portal forwards flat string/CSV params, so
// the shared parser (which already handles string | string[]) accepts it as-is.
function queryBag(req: Request): Record<string, string | string[] | undefined> {
  return req.query as unknown as Record<string, string | string[] | undefined>;
}

function companyIdOf(req: Request): string | null {
  return req.user?.companyId ?? null;
}

// ── Diamonds ──────────────────────────────────────────────────────────────
catalogRouter.get(
  "/diamonds",
  wrap(async (req, res) => {
    const origin = DiamondOriginSchema.safeParse(req.query.origin);
    if (!origin.success) {
      res.status(400).json({ error: "origin must be 'Lab' or 'Natural'" });
      return;
    }
    const params = parseDiamondSearchParams(queryBag(req));
    const result = await searchDiamonds(params, origin.data, companyIdOf(req));
    res.json(result);
  })
);

catalogRouter.get(
  "/diamonds/bounds",
  wrap(async (req, res) => {
    const origin = DiamondOriginSchema.safeParse(req.query.origin);
    if (!origin.success) {
      res.status(400).json({ error: "origin must be 'Lab' or 'Natural'" });
      return;
    }
    const bounds = await getDiamondFilterBounds(origin.data, companyIdOf(req));
    res.json(bounds);
  })
);

// Filtered match count (powers the live "N matches" badge on the search form).
catalogRouter.get(
  "/diamonds/count",
  wrap(async (req, res) => {
    const origin = DiamondOriginSchema.safeParse(req.query.origin);
    if (!origin.success) {
      res.status(400).json({ error: "origin must be 'Lab' or 'Natural'" });
      return;
    }
    const params = parseDiamondSearchParams(queryBag(req));
    const count = await countDiamonds(params.filters, origin.data, companyIdOf(req), params.query);
    res.json({ count });
  })
);

// ── Gemstones ─────────────────────────────────────────────────────────────
catalogRouter.get(
  "/gemstones",
  wrap(async (req, res) => {
    const params = parseGemstoneSearchParams(queryBag(req));
    const result = await searchGemstones(params, companyIdOf(req));
    res.json(result);
  })
);

catalogRouter.get(
  "/gemstones/bounds",
  wrap(async (req, res) => {
    const bounds = await getGemstoneFilterBounds(companyIdOf(req));
    res.json(bounds);
  })
);

catalogRouter.get(
  "/gemstones/count",
  wrap(async (req, res) => {
    const params = parseGemstoneSearchParams(queryBag(req));
    const count = await countGemstones(params.filters, companyIdOf(req), params.query);
    res.json({ count });
  })
);

// ── Shared ────────────────────────────────────────────────────────────────
catalogRouter.get(
  "/counts",
  wrap(async (_req, res) => {
    res.json(await getInventoryCounts());
  })
);

// Single item by id — tries gemstone first, then diamond (mirrors the portal's
// /items/[itemId] page resolution). Response is discriminated by `type`.
catalogRouter.get(
  "/items/:id",
  wrap(async (req, res) => {
    const companyId = companyIdOf(req);
    const id = req.params.id;

    const gemstone = await getGemstoneByIdForBuyer(id, companyId);
    if (gemstone) {
      res.json({ type: "gemstone", gemstone });
      return;
    }
    const diamond = await getDiamondByIdForBuyer(id, companyId);
    if (diamond) {
      res.json({ type: "diamond", diamond });
      return;
    }
    res.status(404).json({ error: "Item not found" });
  })
);
