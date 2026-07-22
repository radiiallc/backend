import { z } from "zod";

// ────────────────────────────────────────────────────────────────────────────
// IMS wire contract — the shared response DTOs for the in-house inventory /
// back-office admin (`admin/`, radiia-ims). The Prisma schema normalizes
// everything (parties → FKs, per-type fields → detail tables, totals derived);
// these DTOs re-expose that in the shape the admin renders. Field-by-field
// provenance: docs/phase-h/admin-schema-reconciliation.md.
//
// Money/measurement columns are Prisma Decimals in the DB → `number | null` on
// the wire. Dates → ISO strings. `StoneDetail.certUrl` is SERVER-READ-ONLY and
// is NEVER placed on a DTO — the admin builds its GIA/IGI lookup from
// certNumber + lab instead (platform invariant: a vendor host never reaches a
// browser). Read-only for this first (reads) pass; write DTOs come with the
// service layer.
// ────────────────────────────────────────────────────────────────────────────

// ── Enums (mirror the Prisma enums 1:1) ──────────────────────────────────────

export const ItemTypeSchema = z.enum(["STONE", "JEWELRY", "OTHER_MATERIAL"]);
export type ItemType = z.infer<typeof ItemTypeSchema>;

export const ItemSubtypeSchema = z.enum(["SINGLE", "PAIR", "PARCEL"]);
export type ItemSubtype = z.infer<typeof ItemSubtypeSchema>;

export const StoneTypeSchema = z.enum(["NATURAL", "LAB"]);
export type StoneType = z.infer<typeof StoneTypeSchema>;

export const ItemStatusSchema = z.enum([
  "IN_STOCK",
  "RESERVED",
  "ON_MEMO",
  "SOLD",
  "RETURNED"
]);
export type ItemStatus = z.infer<typeof ItemStatusSchema>;

// ── Per-type detail groups ───────────────────────────────────────────────────

// Diamonds + gems share this shape (discriminated by naturalOrLab / gemType).
// `certUrl` is intentionally absent (server-read-only); `hasCert` tells the UI
// whether a scan exists without leaking its URL.
export const ImsStoneDetailSchema = z.object({
  gemType: z.string().nullable(),
  naturalOrLab: StoneTypeSchema.nullable(),
  shape: z.string(),
  weightCt: z.number().nullable(),
  quantity: z.number().nullable(),
  color: z.string().nullable(),
  fancyColor: z.string().nullable(),
  fancyIntensity: z.string().nullable(),
  fancyOvertone: z.string().nullable(),
  clarity: z.string().nullable(),
  cutGrade: z.string().nullable(),
  polish: z.string().nullable(),
  symmetry: z.string().nullable(),
  fluorescence: z.string().nullable(),
  lengthMm: z.number().nullable(),
  widthMm: z.number().nullable(),
  heightMm: z.number().nullable(),
  depthPct: z.number().nullable(),
  tablePct: z.number().nullable(),
  girdle: z.string().nullable(),
  ratio: z.number().nullable(),
  lab: z.string().nullable(),
  certNumber: z.string().nullable(),
  hasCert: z.boolean(),
  origin: z.string().nullable(),
  treatment: z.string().nullable(),
  costPerCt: z.number().nullable(),
  wholesalePricePerCt: z.number().nullable(),
  totalCost: z.number().nullable(),
  totalWholesalePrice: z.number().nullable(),
  photo1Url: z.string().nullable(),
  photo2Url: z.string().nullable(),
  videoUrl: z.string().nullable()
});
export type ImsStoneDetail = z.infer<typeof ImsStoneDetailSchema>;

export const ImsJewelryDetailSchema = z.object({
  jewelryItemType: z.string(),
  description: z.string().nullable(),
  quantity: z.number(),
  metal: z.string(),
  lengthMm: z.number().nullable(),
  ringSize: z.string().nullable(),
  mm: z.number().nullable(),
  metalWeightGrams: z.number().nullable(),
  productionCost: z.number().nullable(),
  wholesalePrice: z.number().nullable(),
  retailPrice: z.number().nullable(),
  brand: z.string().nullable(),
  certNumber: z.string().nullable(),
  photo1Url: z.string().nullable(),
  photo2Url: z.string().nullable(),
  videoUrl: z.string().nullable()
});
export type ImsJewelryDetail = z.infer<typeof ImsJewelryDetailSchema>;

export const ImsOtherMaterialDetailSchema = z.object({
  category: z.string().nullable(),
  subtype: z.string(),
  quantity: z.number(),
  metalType: z.string(),
  lengthMm: z.number().nullable(),
  size: z.string().nullable(),
  mm: z.number().nullable(),
  weightGrams: z.number().nullable(),
  description: z.string().nullable(),
  cost: z.number().nullable(),
  wholesalePrice: z.number().nullable(),
  photo1Url: z.string().nullable(),
  photo2Url: z.string().nullable(),
  videoUrl: z.string().nullable()
});
export type ImsOtherMaterialDetail = z.infer<typeof ImsOtherMaterialDetailSchema>;

// ── Inventory item (core + exactly one detail group) ─────────────────────────

export const ImsInventoryItemSchema = z.object({
  id: z.string(),
  sku: z.string(),
  vendorSku: z.string().nullable(),
  itemName: z.string().nullable(),
  itemType: ItemTypeSchema,
  itemSubtype: ItemSubtypeSchema.nullable(),
  status: ItemStatusSchema,
  // Party FKs + resolved display names (the admin store keeps flat names).
  vendorId: z.string().nullable(),
  vendorName: z.string().nullable(),
  brandOwnerId: z.string().nullable(),
  brandOwnerName: z.string().nullable(),
  reservedForClientId: z.string().nullable(),
  reservedForClientName: z.string().nullable(),
  reservedAt: z.string().nullable(),
  visibleOnPortal: z.boolean(),
  enteredStockAt: z.string(),
  notes: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Derived media summary (the store shows a 0/1/2 photo count + a video flag).
  photoCount: z.number(),
  hasVideo: z.boolean(),
  // Exactly one of these is present, keyed by itemType.
  stone: ImsStoneDetailSchema.nullable(),
  jewelry: ImsJewelryDetailSchema.nullable(),
  material: ImsOtherMaterialDetailSchema.nullable()
});
export type ImsInventoryItem = z.infer<typeof ImsInventoryItemSchema>;

// ── Vendor ───────────────────────────────────────────────────────────────────

export const ImsVendorSchema = z.object({
  id: z.string(),
  name: z.string(),
  contactName: z.string().nullable(),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  address: z.string().nullable(),
  defaultMemoTermsDays: z.number().nullable(),
  defaultInvoiceTermsDays: z.number().nullable(),
  quickbooksId: z.string().nullable(),
  notes: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Derived: how many inventory rows currently point at this vendor.
  inventoryItemCount: z.number()
});
export type ImsVendor = z.infer<typeof ImsVendorSchema>;

// ── Vocabulary (self-growing pick-or-add lists) ──────────────────────────────

// The admin ships 11 SHARED kinds; the backend adds 2 for the two-level
// other-materials picker. Keep this list in sync with the schema comment on
// `VocabularyValue` and admin-schema-reconciliation.md (decision C).
export const VOCAB_KINDS = [
  "gem",
  "shape",
  "color",
  "clarity",
  "cut",
  "lab",
  "origin",
  "treat",
  "metal",
  "jtype",
  "brand",
  "other_category",
  "other_material_type"
] as const;
export type VocabKind = (typeof VOCAB_KINDS)[number];

export const ImsVocabularyValueSchema = z.object({
  id: z.string(),
  kind: z.string(),
  value: z.string()
});
export type ImsVocabularyValue = z.infer<typeof ImsVocabularyValueSchema>;

// ── List query params ────────────────────────────────────────────────────────

export const ImsInventoryQuerySchema = z.object({
  type: ItemTypeSchema.optional(),
  status: ItemStatusSchema.optional(),
  // Free-text over sku / vendorSku / itemName (case-insensitive contains).
  q: z.string().trim().min(1).optional(),
  visible: z.enum(["true", "false"]).optional()
});
export type ImsInventoryQuery = z.infer<typeof ImsInventoryQuerySchema>;

// ── Documents ────────────────────────────────────────────────────────────────
// Back-office inbound/outbound docs. Direction, party kind, party name, line
// count and total are all DERIVED on read (never stored) — see
// admin-schema-reconciliation.md §Document.

export const DocumentTypeSchema = z.enum([
  "BILL_IN",
  "MEMO_IN",
  "BRAND_INVENTORY_IN",
  "MEMO_OUT",
  "INVOICE",
  "PURCHASE_ORDER",
  "RETURN_MEMO_OUT",
  "RETURN_MEMO_IN",
  "BRAND_INVENTORY_OUT"
]);
export type DocumentType = z.infer<typeof DocumentTypeSchema>;

export const DocumentStatusSchema = z.enum(["OPEN", "CLOSED", "EXPORTED", "BILLED", "VOID"]);
export type DocumentStatus = z.infer<typeof DocumentStatusSchema>;

export const LineStatusSchema = z.enum(["IN_STOCK", "ON_MEMO", "SOLD", "RETURNED"]);
export type LineStatus = z.infer<typeof LineStatusSchema>;

export const CloseReasonSchema = z.enum(["RETURNED", "SOLD", "MIXED"]);
export type CloseReason = z.infer<typeof CloseReasonSchema>;

export const DocDirectionSchema = z.enum(["in", "out"]);
export type DocDirection = z.infer<typeof DocDirectionSchema>;

export const PartyKindSchema = z.enum(["vendor", "client"]);
export type PartyKind = z.infer<typeof PartyKindSchema>;

export const ImsDocumentLineItemSchema = z.object({
  id: z.string(),
  inventoryItemId: z.string(),
  itemSku: z.string(),
  itemName: z.string().nullable(),
  lineStatus: LineStatusSchema,
  resolvedByDocumentId: z.string().nullable(),
  resolvedByDocumentNumber: z.string().nullable(),
  quantity: z.number().nullable(),
  caratWeight: z.number().nullable(),
  unitPrice: z.number().nullable(),
  totalPrice: z.number().nullable(),
  discountAmount: z.number().nullable(),
  clientReference: z.string().nullable(),
  notes: z.string().nullable()
});
export type ImsDocumentLineItem = z.infer<typeof ImsDocumentLineItemSchema>;

export const ImsDocumentSchema = z.object({
  id: z.string(),
  type: DocumentTypeSchema,
  documentNumber: z.string().nullable(),
  externalReference: z.string().nullable(),
  status: DocumentStatusSchema,
  direction: DocDirectionSchema,
  partyKind: PartyKindSchema.nullable(),
  vendorId: z.string().nullable(),
  clientId: z.string().nullable(),
  partyName: z.string().nullable(),
  issueDate: z.string(),
  dueDate: z.string().nullable(),
  discountAmount: z.number().nullable(),
  notes: z.string().nullable(),
  emailedAt: z.string().nullable(),
  quickbooksSyncedAt: z.string().nullable(),
  closeReason: CloseReasonSchema.nullable(),
  parentDocumentId: z.string().nullable(),
  parentDocumentNumber: z.string().nullable(),
  createdById: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lineCount: z.number(),
  total: z.number().nullable(),
  lineItems: z.array(ImsDocumentLineItemSchema)
});
export type ImsDocument = z.infer<typeof ImsDocumentSchema>;

export const ImsDocumentQuerySchema = z.object({
  type: DocumentTypeSchema.optional(),
  status: DocumentStatusSchema.optional(),
  direction: DocDirectionSchema.optional()
});
export type ImsDocumentQuery = z.infer<typeof ImsDocumentQuerySchema>;

// Create an outbound document that draws down existing inventory. This first
// write slice covers the two types that transition item status: MEMO_OUT
// (items -> ON_MEMO) and INVOICE (items -> SOLD). PO / inbound / returns land in
// later slices.
export const ImsCreateDocumentSchema = z.object({
  type: z.enum(["MEMO_OUT", "INVOICE"]),
  clientId: z.string().min(1),
  inventoryItemIds: z.array(z.string().min(1)).min(1),
  discountAmount: z.number().nonnegative().optional(),
  notes: z.string().optional()
});
export type ImsCreateDocument = z.infer<typeof ImsCreateDocumentSchema>;
