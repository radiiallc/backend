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

// Back-office CLIENT (a portal Company doubles as the "Client", baseline D4)
// approval lifecycle — admin #0045. PENDING → ACTIVE|DECLINED; ACTIVE ⇄
// DEACTIVATED. Distinct from the per-user UserStatus.
export const ClientStatusSchema = z.enum(["PENDING", "ACTIVE", "DECLINED", "DEACTIVATED"]);
export type ClientStatus = z.infer<typeof ClientStatusSchema>;

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

// ── Inventory write DTOs (manual create / edit) ──────────────────────────────
// Per-type detail inputs mirror the read detail shapes MINUS the server-only /
// derived fields: `certUrl` never crosses the wire (platform invariant), and
// `totalCost` / `totalWholesalePrice` are app-computed on write (carat × per-ct),
// never accepted from the client. shape+weightCt (stone), jewelryItemType+metal+
// productionCost (jewelry), subtype+metalType+cost (other) are required to match
// the non-nullable schema columns; everything else is optional/nullable.

export const ImsStoneDetailInputSchema = z.object({
  gemType: z.string().nullable().optional(),
  naturalOrLab: StoneTypeSchema.nullable().optional(),
  shape: z.string().min(1),
  weightCt: z.number().positive(),
  quantity: z.number().int().nullable().optional(),
  color: z.string().nullable().optional(),
  fancyColor: z.string().nullable().optional(),
  fancyIntensity: z.string().nullable().optional(),
  fancyOvertone: z.string().nullable().optional(),
  clarity: z.string().nullable().optional(),
  cutGrade: z.string().nullable().optional(),
  polish: z.string().nullable().optional(),
  symmetry: z.string().nullable().optional(),
  fluorescence: z.string().nullable().optional(),
  lengthMm: z.number().nullable().optional(),
  widthMm: z.number().nullable().optional(),
  heightMm: z.number().nullable().optional(),
  depthPct: z.number().nullable().optional(),
  tablePct: z.number().nullable().optional(),
  girdle: z.string().nullable().optional(),
  ratio: z.number().nullable().optional(),
  lab: z.string().nullable().optional(),
  certNumber: z.string().nullable().optional(),
  origin: z.string().nullable().optional(),
  treatment: z.string().nullable().optional(),
  costPerCt: z.number().nullable().optional(),
  wholesalePricePerCt: z.number().nullable().optional(),
  photo1Url: z.string().nullable().optional(),
  photo2Url: z.string().nullable().optional(),
  videoUrl: z.string().nullable().optional()
});
export type ImsStoneDetailInput = z.infer<typeof ImsStoneDetailInputSchema>;

export const ImsJewelryDetailInputSchema = z.object({
  jewelryItemType: z.string().min(1),
  description: z.string().nullable().optional(),
  quantity: z.number().int().positive().optional(),
  metal: z.string().min(1),
  lengthMm: z.number().nullable().optional(),
  ringSize: z.string().nullable().optional(),
  mm: z.number().nullable().optional(),
  metalWeightGrams: z.number().nullable().optional(),
  productionCost: z.number().nonnegative(),
  wholesalePrice: z.number().nullable().optional(),
  retailPrice: z.number().nullable().optional(),
  brand: z.string().nullable().optional(),
  certNumber: z.string().nullable().optional(),
  photo1Url: z.string().nullable().optional(),
  photo2Url: z.string().nullable().optional(),
  videoUrl: z.string().nullable().optional()
});
export type ImsJewelryDetailInput = z.infer<typeof ImsJewelryDetailInputSchema>;

export const ImsOtherMaterialDetailInputSchema = z.object({
  category: z.string().nullable().optional(),
  subtype: z.string().min(1),
  quantity: z.number().int().positive().optional(),
  metalType: z.string().min(1),
  lengthMm: z.number().nullable().optional(),
  size: z.string().nullable().optional(),
  mm: z.number().nullable().optional(),
  weightGrams: z.number().nullable().optional(),
  description: z.string().nullable().optional(),
  cost: z.number().nonnegative(),
  wholesalePrice: z.number().nullable().optional(),
  photo1Url: z.string().nullable().optional(),
  photo2Url: z.string().nullable().optional(),
  videoUrl: z.string().nullable().optional()
});
export type ImsOtherMaterialDetailInput = z.infer<typeof ImsOtherMaterialDetailInputSchema>;

// Core fields shared by every create branch. Status is deliberately NOT settable
// here — a new item always enters IN_STOCK, and status thereafter moves only
// through documents (memo/invoice/return) or reserve/release, never a raw write.
const coreCreateFields = {
  vendorId: z.string().min(1).optional(),
  brandOwnerId: z.string().min(1).optional(),
  itemName: z.string().optional(),
  vendorSku: z.string().optional(),
  notes: z.string().optional(),
  visibleOnPortal: z.boolean().optional()
};

// Create one inventory item + its single detail group, keyed by itemType. The
// SKU is auto-minted server-side (admin never types it on create).
export const ImsCreateInventoryItemSchema = z.discriminatedUnion("itemType", [
  z.object({
    itemType: z.literal("STONE"),
    itemSubtype: ItemSubtypeSchema.optional(),
    ...coreCreateFields,
    stone: ImsStoneDetailInputSchema
  }),
  z.object({
    itemType: z.literal("JEWELRY"),
    ...coreCreateFields,
    jewelry: ImsJewelryDetailInputSchema
  }),
  z.object({
    itemType: z.literal("OTHER_MATERIAL"),
    ...coreCreateFields,
    material: ImsOtherMaterialDetailInputSchema
  })
]);
export type ImsCreateInventoryItem = z.infer<typeof ImsCreateInventoryItemSchema>;

// Patch an item: any subset of core fields + a partial patch of its OWN detail
// group (the service rejects a detail patch that doesn't match the item's type).
// itemType is immutable; status is not patchable (see coreCreateFields note).
// null clears a nullable field; an absent key leaves it unchanged.
export const ImsUpdateInventoryItemSchema = z.object({
  sku: z.string().min(1).optional(),
  vendorId: z.string().min(1).nullable().optional(),
  brandOwnerId: z.string().min(1).nullable().optional(),
  itemName: z.string().nullable().optional(),
  vendorSku: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  visibleOnPortal: z.boolean().optional(),
  itemSubtype: ItemSubtypeSchema.nullable().optional(),
  stone: ImsStoneDetailInputSchema.partial().optional(),
  jewelry: ImsJewelryDetailInputSchema.partial().optional(),
  material: ImsOtherMaterialDetailInputSchema.partial().optional()
});
export type ImsUpdateInventoryItem = z.infer<typeof ImsUpdateInventoryItemSchema>;

// Reserve a hold on an in-stock item for a client (admin reserve/hold). Release
// takes no body. This is the ONE non-document status move (IN_STOCK ↔ RESERVED).
export const ImsReserveItemSchema = z.object({ clientId: z.string().min(1) });
export type ImsReserveItem = z.infer<typeof ImsReserveItemSchema>;

// Add (or reuse) a self-growing vocabulary value (admin pick-or-add). Dedups
// case-insensitively within a kind; `kind` is one of the shared VOCAB_KINDS.
export const ImsCreateVocabularySchema = z.object({
  kind: z.enum(VOCAB_KINDS),
  value: z.string().trim().min(1)
});
export type ImsCreateVocabulary = z.infer<typeof ImsCreateVocabularySchema>;

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

// Record a return against an open Memo Out (admin #0025 / recordMemoReturn).
// Omit inventoryItemIds (or send []) to return every stone still ON_MEMO;
// otherwise return just the named ones (a partial return leaves the memo OPEN).
export const ImsRecordReturnSchema = z.object({
  inventoryItemIds: z.array(z.string().min(1)).optional()
});
export type ImsRecordReturn = z.infer<typeof ImsRecordReturnSchema>;

// Create a Purchase Order — a vendor-addressed outbound doc committing RADIIA to
// buy the listed inventory items from that vendor. Distinct from the client-doc
// create above: it carries a vendorId (not a clientId), prices each line at COST
// (a PO export is "vendor-safe: no client / wholesale"), and does NOT transition
// item status (the PO is the order; a later Bill In receives the goods).
export const ImsCreatePurchaseOrderSchema = z.object({
  vendorId: z.string().min(1),
  inventoryItemIds: z.array(z.string().min(1)).min(1),
  discountAmount: z.number().nonnegative().optional(),
  notes: z.string().optional()
});
export type ImsCreatePurchaseOrder = z.infer<typeof ImsCreatePurchaseOrderSchema>;

// Batch document-id payload — shared by the "email these docs" and "sync these
// docs to QuickBooks" actions (admin sendEmail / _runSync both act on the set of
// selected docs). Both endpoints stamp a timestamp (emailedAt /
// quickbooksSyncedAt) and return the updated docs.
export const ImsDocumentIdsSchema = z.object({
  documentIds: z.array(z.string().min(1)).min(1)
});
export type ImsDocumentIds = z.infer<typeof ImsDocumentIdsSchema>;

// ── Clients (back-office accounts) ───────────────────────────────────────────
// A portal Company IS the back-office Client (baseline D4). These DTOs re-expose
// it in the shape the admin's Clients tab renders: contact + shipping, the three
// portal markups, credit + default terms, QuickBooks link, staff-only internal
// notes, and the approval lifecycle status. `openDocumentCount` (the admin's
// "open: N") is derived — open client documents held against this account.

export const ImsClientSchema = z.object({
  id: z.string(),
  name: z.string(),
  contactName: z.string().nullable(),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  website: z.string().nullable(),
  shippingAddress: z.string().nullable(),
  clientStatus: ClientStatusSchema,
  creditLimitUsd: z.number(),
  gemstoneMarkupPct: z.number(),
  labDiamondMarkupPct: z.number(),
  naturalDiamondMarkupPct: z.number(),
  defaultMemoTermsDays: z.number().nullable(),
  defaultInvoiceTermsDays: z.number().nullable(),
  quickbooksId: z.string().nullable(),
  // Staff-only note (admin #0045) — never shown to the portal client.
  internalNotes: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Derived: open documents (memo/invoice) currently held against this client.
  openDocumentCount: z.number()
});
export type ImsClient = z.infer<typeof ImsClientSchema>;

export const ImsClientQuerySchema = z.object({
  status: ClientStatusSchema.optional(),
  // Free-text over name / contactEmail / contactName (case-insensitive contains).
  q: z.string().trim().min(1).optional()
});
export type ImsClientQuery = z.infer<typeof ImsClientQuerySchema>;

// Manually add a back-office client (admin "New client" / saveClient). Only the
// name is required; a staff-added account lands ACTIVE (portal self-signups land
// PENDING via the portal auth path, not this endpoint). clientStatus is NOT
// settable here — it moves only through the lifecycle endpoint below.
export const ImsCreateClientSchema = z.object({
  name: z.string().trim().min(1),
  contactName: z.string().nullable().optional(),
  contactEmail: z.string().nullable().optional(),
  contactPhone: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  shippingAddress: z.string().nullable().optional(),
  internalNotes: z.string().optional(),
  creditLimitUsd: z.number().nonnegative().optional(),
  gemstoneMarkupPct: z.number().nonnegative().optional(),
  labDiamondMarkupPct: z.number().nonnegative().optional(),
  naturalDiamondMarkupPct: z.number().nonnegative().optional(),
  defaultMemoTermsDays: z.number().int().positive().nullable().optional(),
  defaultInvoiceTermsDays: z.number().int().positive().nullable().optional(),
  quickbooksId: z.string().nullable().optional()
});
export type ImsCreateClient = z.infer<typeof ImsCreateClientSchema>;

// Patch a client's core account fields (admin edit + the staff internalNotes
// field). clientStatus is deliberately absent — approval moves only through the
// lifecycle endpoint. null clears a nullable field; an absent key is unchanged.
export const ImsUpdateClientSchema = z.object({
  name: z.string().trim().min(1).optional(),
  contactName: z.string().nullable().optional(),
  contactEmail: z.string().nullable().optional(),
  contactPhone: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  shippingAddress: z.string().nullable().optional(),
  internalNotes: z.string().optional(),
  creditLimitUsd: z.number().nonnegative().optional(),
  gemstoneMarkupPct: z.number().nonnegative().optional(),
  labDiamondMarkupPct: z.number().nonnegative().optional(),
  naturalDiamondMarkupPct: z.number().nonnegative().optional(),
  defaultMemoTermsDays: z.number().int().positive().nullable().optional(),
  defaultInvoiceTermsDays: z.number().int().positive().nullable().optional(),
  quickbooksId: z.string().nullable().optional()
});
export type ImsUpdateClient = z.infer<typeof ImsUpdateClientSchema>;

// Move a client through its approval lifecycle (admin approve/decline/
// deactivate/reactivate). The verb — not a raw target status — because `approve`
// carries the portal-markups guard (a signup lands with 0 markups) that a bare
// "set ACTIVE" wouldn't. The service validates the (current → action) pair:
// approve/decline from PENDING, deactivate from ACTIVE, reactivate from DEACTIVATED.
export const ClientLifecycleActionSchema = z.enum([
  "approve",
  "decline",
  "deactivate",
  "reactivate"
]);
export type ClientLifecycleAction = z.infer<typeof ClientLifecycleActionSchema>;

export const ImsClientLifecycleSchema = z.object({ action: ClientLifecycleActionSchema });
export type ImsClientLifecycle = z.infer<typeof ImsClientLifecycleSchema>;
