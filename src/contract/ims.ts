import { z } from "zod";

// ────────────────────────────────────────────────────────────────────────────
// IMS inventory wire contract (Phase H3). Shared definition of the inventory
// CRUD request bodies + response DTOs flowing between apps/api and the admin
// frontend. Mirrors the Prisma enums in prisma/schema.prisma (§H1); kept in zod
// so both sides share inferred types and the api validates at the boundary.
//
// All money/measurement values cross the wire as `number | null` (Prisma Decimal
// is serialized to a JS number in the DTOs); the services convert to/from the
// Decimal columns. Dates cross as ISO strings.
// ────────────────────────────────────────────────────────────────────────────

// ── Enums (mirror schema.prisma) ─────────────────────────────────────────────
export const ItemTypeSchema = z.enum(["STONE", "JEWELRY", "OTHER_MATERIAL"]);
export type ItemTypeValue = z.infer<typeof ItemTypeSchema>;

export const ItemSubtypeSchema = z.enum(["SINGLE", "PAIR", "PARCEL"]);
export type ItemSubtypeValue = z.infer<typeof ItemSubtypeSchema>;

export const ItemStatusSchema = z.enum([
  "IN_STOCK",
  "RESERVED",
  "ON_MEMO",
  "ON_CONSIGNMENT",
  "SOLD",
  "RETURNED"
]);
export type ItemStatusValue = z.infer<typeof ItemStatusSchema>;

export const CertLabSchema = z.enum(["GIA", "IGI", "NONE"]);
export type CertLabValue = z.infer<typeof CertLabSchema>;

export const StoneTypeSchema = z.enum(["NATURAL", "LAB"]);
export type StoneTypeValue = z.infer<typeof StoneTypeSchema>;

export const OtherMaterialSubtypeSchema = z.enum([
  "BRACELET_MOUNTING",
  "EARRING_MOUNTING",
  "EARRING_BACK",
  "EARRING_POST",
  "CLASP",
  "OTHER"
]);
export type OtherMaterialSubtypeValue = z.infer<typeof OtherMaterialSubtypeSchema>;

// ── Per-type detail inputs ───────────────────────────────────────────────────
// All fields optional on input; the service stores what's given. Derived fields
// (ratio, totalWholesalePrice, totalCost) are NOT accepted from the client — the
// api computes them (computeDerived). Media URLs land in H3.3 and are managed by
// the upload endpoints, not this CRUD body.
const nullableNumber = z.number().nullable().optional();
const nullableString = z.string().nullable().optional();

export const StoneDetailInputSchema = z.object({
  gemType: nullableString,
  shape: nullableString,
  weightCt: nullableNumber,
  quantity: z.number().int().nullable().optional(), // parcel running qty
  color: nullableString,
  fancyColor: nullableString,
  fancyIntensity: nullableString,
  fancyOvertone: nullableString,
  clarity: nullableString,
  cutGrade: nullableString,
  polish: nullableString,
  symmetry: nullableString,
  fluorescence: nullableString,
  lengthMm: nullableNumber,
  widthMm: nullableNumber,
  heightMm: nullableNumber,
  depthPct: nullableNumber,
  tablePct: nullableNumber,
  girdle: nullableString,
  lab: CertLabSchema.optional(),
  certNumber: nullableString,
  certUrl: nullableString,
  naturalOrLab: StoneTypeSchema.nullable().optional(),
  origin: nullableString,
  treatment: nullableString,
  wholesalePricePerCt: nullableNumber,
  costPerCt: nullableNumber
});
export type StoneDetailInput = z.infer<typeof StoneDetailInputSchema>;

export const JewelryDetailInputSchema = z.object({
  brand: nullableString,
  jewelryItemType: nullableString,
  metal: nullableString,
  ringSize: nullableString,
  lengthMm: nullableNumber,
  productionCost: nullableNumber,
  wholesalePrice: nullableNumber,
  retailPrice: nullableNumber,
  description: nullableString,
  certNumber: nullableString
});
export type JewelryDetailInput = z.infer<typeof JewelryDetailInputSchema>;

export const OtherMaterialDetailInputSchema = z.object({
  subtype: OtherMaterialSubtypeSchema.nullable().optional(),
  metalType: nullableString,
  lengthMm: nullableNumber,
  widthMm: nullableNumber,
  weightGrams: nullableNumber,
  quantity: z.number().int().nullable().optional(),
  description: nullableString,
  cost: nullableNumber
});
export type OtherMaterialDetailInput = z.infer<typeof OtherMaterialDetailInputSchema>;

// ── Create ───────────────────────────────────────────────────────────────────
// Minimal-required: itemType only. sku auto-generates when absent (§4.4);
// status defaults IN_STOCK, visibleOnPortal defaults false. The matching detail
// block for itemType is optional but, when present, must be the right one — the
// service ignores detail blocks that don't match itemType.
export const CreateInventoryItemSchema = z.object({
  sku: z.string().trim().min(1).optional(),
  itemType: ItemTypeSchema,
  itemSubtype: ItemSubtypeSchema.nullable().optional(),
  status: ItemStatusSchema.optional(),
  visibleOnPortal: z.boolean().optional(),
  vendorId: nullableString,
  brandOwnerId: nullableString,
  notes: nullableString,
  enteredStockAt: z.string().datetime().optional(),
  reservedForClientId: nullableString,
  stone: StoneDetailInputSchema.optional(),
  jewelry: JewelryDetailInputSchema.optional(),
  other: OtherMaterialDetailInputSchema.optional()
});
export type CreateInventoryItemBody = z.infer<typeof CreateInventoryItemSchema>;

// ── Update ───────────────────────────────────────────────────────────────────
// Any core field + the matching detail block. SKU is intentionally NOT updatable
// (immutable identifier, never mutated on parcels — §5 schema note). itemType is
// not changeable (it would orphan the wrong detail table). Status changes that
// move stock belong to the document engine (H4+); this endpoint sets simple
// fields. Detail blocks are partial-merge: only provided keys are written.
export const UpdateInventoryItemSchema = z.object({
  itemSubtype: ItemSubtypeSchema.nullable().optional(),
  visibleOnPortal: z.boolean().optional(),
  vendorId: nullableString,
  brandOwnerId: nullableString,
  notes: nullableString,
  enteredStockAt: z.string().datetime().optional(),
  stone: StoneDetailInputSchema.optional(),
  jewelry: JewelryDetailInputSchema.optional(),
  other: OtherMaterialDetailInputSchema.optional()
});
export type UpdateInventoryItemBody = z.infer<typeof UpdateInventoryItemSchema>;

export const TogglePortalVisibilitySchema = z.object({
  visibleOnPortal: z.boolean()
});
export type TogglePortalVisibilityBody = z.infer<typeof TogglePortalVisibilitySchema>;

// ── List query ───────────────────────────────────────────────────────────────
export const INVENTORY_SORT_KEYS = [
  "newest",
  "oldest",
  "sku-asc",
  "sku-desc",
  "price-asc",
  "price-desc",
  "days-in-stock-desc",
  "days-in-stock-asc"
] as const;
export type InventorySortKey = (typeof INVENTORY_SORT_KEYS)[number];

export const INVENTORY_MEDIA_FILTER = ["all", "with", "without"] as const;
export type InventoryMediaFilter = (typeof INVENTORY_MEDIA_FILTER)[number];

export type InventoryListParams = {
  query?: string; // matches SKU / notes / stone gemType+shape
  status?: ItemStatusValue;
  itemType?: ItemTypeValue;
  vendorId?: string;
  brandOwnerId?: string;
  visibleOnPortal?: boolean;
  media?: InventoryMediaFilter;
  sort: InventorySortKey;
  page: number;
  perPage: number;
};

// ── DTOs ─────────────────────────────────────────────────────────────────────
// List row: trimmed — NO media URLs / heavy fields (mirror DIAMOND_CARD_SELECT,
// WORKPLAN §A6). Just what the inventory table renders.
export const InventoryListRowSchema = z.object({
  id: z.string(),
  sku: z.string(),
  itemType: ItemTypeSchema,
  itemSubtype: ItemSubtypeSchema.nullable(),
  status: ItemStatusSchema,
  visibleOnPortal: z.boolean(),
  vendorName: z.string().nullable(),
  brandOwnerName: z.string().nullable(),
  enteredStockAt: z.string(),
  daysInStock: z.number(),
  // A short human label of the item, derived per type (e.g. "1.01ct Round F VS1").
  summary: z.string(),
  totalWholesalePrice: z.number().nullable(),
  hasMedia: z.boolean()
});
export type InventoryListRow = z.infer<typeof InventoryListRowSchema>;

export const InventoryListResultSchema = z.object({
  items: z.array(InventoryListRowSchema),
  total: z.number(),
  page: z.number(),
  perPage: z.number(),
  totalPages: z.number()
});
export type InventoryListResult = z.infer<typeof InventoryListResultSchema>;

// Full detail DTO — every stored field + status history + linked documents.
export const StoneDetailDtoSchema = StoneDetailInputSchema.extend({
  // Server-computed derived fields are read-only on the wire.
  ratio: z.number().nullable(),
  totalWholesalePrice: z.number().nullable(),
  totalCost: z.number().nullable(),
  photo1Url: z.string().nullable(),
  photo2Url: z.string().nullable(),
  videoUrl: z.string().nullable()
});
export type StoneDetailDto = z.infer<typeof StoneDetailDtoSchema>;

export const ItemStatusHistoryRowSchema = z.object({
  id: z.string(),
  previousStatus: ItemStatusSchema.nullable(),
  newStatus: ItemStatusSchema,
  documentId: z.string().nullable(),
  changedByName: z.string().nullable(),
  changedAt: z.string(),
  notes: z.string().nullable()
});
export type ItemStatusHistoryRow = z.infer<typeof ItemStatusHistoryRowSchema>;

export const LinkedDocumentRowSchema = z.object({
  id: z.string(),
  type: z.string(),
  documentNumber: z.string().nullable(),
  externalReference: z.string().nullable(),
  status: z.string(),
  lineStatus: z.string(),
  issueDate: z.string()
});
export type LinkedDocumentRow = z.infer<typeof LinkedDocumentRowSchema>;

export const InventoryItemDetailSchema = z.object({
  id: z.string(),
  sku: z.string(),
  itemType: ItemTypeSchema,
  itemSubtype: ItemSubtypeSchema.nullable(),
  status: ItemStatusSchema,
  visibleOnPortal: z.boolean(),
  vendorId: z.string().nullable(),
  vendorName: z.string().nullable(),
  brandOwnerId: z.string().nullable(),
  brandOwnerName: z.string().nullable(),
  reservedForClientId: z.string().nullable(),
  reservedForClientName: z.string().nullable(),
  reservedAt: z.string().nullable(),
  notes: z.string().nullable(),
  enteredStockAt: z.string(),
  daysInStock: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  stone: StoneDetailDtoSchema.nullable(),
  jewelry: JewelryDetailInputSchema.nullable(),
  other: OtherMaterialDetailInputSchema.nullable(),
  statusHistory: z.array(ItemStatusHistoryRowSchema),
  documents: z.array(LinkedDocumentRowSchema)
});
export type InventoryItemDetail = z.infer<typeof InventoryItemDetailSchema>;

// Mutation result shape — mirrors the admin AdminActionResult convention.
export type InventoryMutationResult =
  | { ok: true; id: string; sku: string; warning?: string }
  | { ok: false; error: string };

// ── Media (H3.3) ─────────────────────────────────────────────────────────────
// Stones carry up to 2 photos + 1 video (§4.7). Slots map to StoneDetail columns
// photo1Url / photo2Url / videoUrl. Media is RADIIA-owned (the vendor-host gate
// §6.8 doesn't apply) but kept private + served via short-lived signed URLs.
export const MediaSlotSchema = z.enum(["photo1", "photo2", "video"]);
export type MediaSlot = z.infer<typeof MediaSlotSchema>;

export const RequestUploadUrlSchema = z.object({
  filename: z.string().trim().min(1),
  contentType: z.string().trim().optional()
});
export type RequestUploadUrlBody = z.infer<typeof RequestUploadUrlSchema>;

export const SetMediaPathSchema = z.object({ path: z.string().trim().min(1) });
export type SetMediaPathBody = z.infer<typeof SetMediaPathSchema>;

export type SignedUploadResponse = { uploadUrl: string; path: string };
export type SignedReadResponse = { url: string | null };
