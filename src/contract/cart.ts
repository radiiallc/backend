import { z } from "zod";

export const CartLineSchema = z.object({
  cartItemId: z.string(),
  itemId: z.string(),
  kind: z.enum(["gemstone", "diamond"]),
  gemstoneId: z.string().nullable(),
  diamondId: z.string().nullable(),
  sku: z.string(),
  varietyRaw: z.string().nullable(),
  shapeRaw: z.string().nullable(),
  shapeMapped: z.string().nullable(),
  colorRaw: z.string().nullable(),
  weightCt: z.number().nullable(),
  qty: z.number(),
  displayPriceUsd: z.number().nullable(),
  displayPricePerCtUsd: z.number().nullable(),
  lineTotalUsd: z.number().nullable(),
  isAvailable: z.boolean(),
  imageUrl: z.string().nullable()
});
export type CartLine = z.infer<typeof CartLineSchema>;

export const BuyerCartSchema = z.object({
  cartId: z.string().nullable(),
  items: z.array(CartLineSchema),
  subtotalUsd: z.number()
});
export type BuyerCart = z.infer<typeof BuyerCartSchema>;

export const CartPreviewLineSchema = z.object({
  cartItemId: z.string(),
  itemId: z.string(),
  sku: z.string(),
  title: z.string(),
  qty: z.number(),
  lineTotalUsd: z.number().nullable(),
  shapeRaw: z.string().nullable(),
  shapeMapped: z.string().nullable(),
  imageUrl: z.string().nullable(),
  isAvailable: z.boolean()
});
export type CartPreviewLine = z.infer<typeof CartPreviewLineSchema>;

export const CartPreviewSchema = z.object({
  items: z.array(CartPreviewLineSchema),
  subtotalUsd: z.number(),
  totalCount: z.number(),
  lineCount: z.number()
});
export type CartPreview = z.infer<typeof CartPreviewSchema>;

export const CartCountSchema = z.object({ count: z.number() });
export type CartCount = z.infer<typeof CartCountSchema>;

export type CartActionResult = { ok: true } | { ok: false; error: string };

export const AddToCartBodySchema = z.object({
  itemId: z.string().min(1),
  qty: z.number().int().optional()
});
export type AddToCartBody = z.infer<typeof AddToCartBodySchema>;

export const UpdateCartQtyBodySchema = z.object({
  qty: z.number()
});
export type UpdateCartQtyBody = z.infer<typeof UpdateCartQtyBodySchema>;
