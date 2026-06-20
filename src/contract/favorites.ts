import { z } from "zod";

// ────────────────────────────────────────────────────────────────────────────
// Favorites wire contract. Polymorphic (gemstone XOR diamond) like cart; the
// FavoriteLine.gemstoneId field carries whichever id applies (legacy name).
// addedAt is the ISO string the JSON wire produces (Date in the DB row).
// ────────────────────────────────────────────────────────────────────────────

export const FavoriteLineSchema = z.object({
  favoriteId: z.string(),
  gemstoneId: z.string(),
  sku: z.string(),
  varietyRaw: z.string().nullable(),
  shapeRaw: z.string().nullable(),
  shapeMapped: z.string().nullable(),
  colorRaw: z.string().nullable(),
  weightCt: z.number().nullable(),
  displayPriceUsd: z.number().nullable(),
  displayPricePerCtUsd: z.number().nullable(),
  isAvailable: z.boolean(),
  imageUrl: z.string().nullable(),
  videoUrl: z.string().nullable(),
  addedAt: z.string()
});
export type FavoriteLine = z.infer<typeof FavoriteLineSchema>;

export type FavoriteActionResult =
  | { ok: true; favored: boolean }
  | { ok: false; error: string };

export type FavoriteBulkResult =
  | { ok: true; added: number; failures: string[] }
  | { ok: false; error: string };

export const FavoriteCountSchema = z.object({ count: z.number() });
export type FavoriteCount = z.infer<typeof FavoriteCountSchema>;

// ── Mutation request bodies ─────────────────────────────────────────────────
export const FavoriteItemBodySchema = z.object({ itemId: z.string().min(1) });
export type FavoriteItemBody = z.infer<typeof FavoriteItemBodySchema>;

export const AddFavoritesBulkBodySchema = z.object({ itemIds: z.array(z.string()) });
export type AddFavoritesBulkBody = z.infer<typeof AddFavoritesBulkBodySchema>;
