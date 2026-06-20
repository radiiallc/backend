import { Router, type NextFunction, type Request, type Response } from "express";

import { AddFavoritesBulkBodySchema, FavoriteItemBodySchema } from "@/contract";

import { requireAuth } from "../middleware/auth";
import {
  addFavorite,
  addFavoritesBulk,
  removeFavorite,
  toggleFavorite
} from "../modules/favorites/favorites.service";
import {
  getFavoriteCountForUser,
  getFavoriteGemstoneIdsForUser,
  getFavoritesForBuyer
} from "../modules/favorites/reads";

export const favoritesRouter = Router();

// Favorites require the buyer capability (BUYER or ADMIN) for both reads and
// writes — mirrors the pre-split actions (which returned empty for non-buyers).
favoritesRouter.use(requireAuth);
favoritesRouter.use((req: Request, res: Response, next: NextFunction) => {
  const role = req.user?.role;
  if (role !== "BUYER" && role !== "ADMIN") {
    res.status(403).json({ error: "Not authorized" });
    return;
  }
  next();
});

function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    handler(req, res).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[favorites] handler error", err);
      if (!res.headersSent) res.status(500).json({ error: "Internal error" });
    });
  };
}

function userIdOf(req: Request): string {
  return req.user!.id;
}
function companyIdOf(req: Request): string | null {
  return req.user?.companyId ?? null;
}

// ── Reads ───────────────────────────────────────────────────────────────────
favoritesRouter.get(
  "/",
  wrap(async (req, res) => {
    res.json(await getFavoritesForBuyer(userIdOf(req), companyIdOf(req)));
  })
);

favoritesRouter.get(
  "/count",
  wrap(async (req, res) => {
    res.json({ count: await getFavoriteCountForUser(userIdOf(req)) });
  })
);

favoritesRouter.get(
  "/ids",
  wrap(async (req, res) => {
    res.json(await getFavoriteGemstoneIdsForUser(userIdOf(req)));
  })
);

// ── Mutations ───────────────────────────────────────────────────────────────
favoritesRouter.post(
  "/",
  wrap(async (req, res) => {
    const body = FavoriteItemBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: "Missing item id" });
      return;
    }
    res.json(await addFavorite(userIdOf(req), body.data.itemId));
  })
);

favoritesRouter.post(
  "/toggle",
  wrap(async (req, res) => {
    const body = FavoriteItemBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: "Missing item id" });
      return;
    }
    res.json(await toggleFavorite(userIdOf(req), body.data.itemId));
  })
);

favoritesRouter.post(
  "/bulk",
  wrap(async (req, res) => {
    const body = AddFavoritesBulkBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: "Invalid request body" });
      return;
    }
    res.json(await addFavoritesBulk(userIdOf(req), body.data.itemIds));
  })
);

favoritesRouter.delete(
  "/:itemId",
  wrap(async (req, res) => {
    res.json(await removeFavorite(userIdOf(req), req.params.itemId));
  })
);
