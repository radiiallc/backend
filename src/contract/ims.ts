import { z } from "zod";

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

export const ClientStatusSchema = z.enum(["PENDING", "ACTIVE", "DECLINED", "DEACTIVATED"]);
export type ClientStatus = z.infer<typeof ClientStatusSchema>;

export const ImsStoneDetailSchema = z.object({
  gemType: z.string().nullable(),
  naturalOrLab: StoneTypeSchema.nullable(),
  shape: z.string(),
  weightCt: z.number().nullable(),
  quantity: z.number().nullable(),
  remainingCt: z.number().nullable(),
  remainingQty: z.number().nullable(),
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
  retailPricePerCt: z.number().nullable(),
  totalCost: z.number().nullable(),
  totalWholesalePrice: z.number().nullable(),
  totalRetailPrice: z.number().nullable(),
  photo1Url: z.string().nullable(),
  photo2Url: z.string().nullable(),
  videoUrl: z.string().nullable()
});
export type ImsStoneDetail = z.infer<typeof ImsStoneDetailSchema>;

export const ImsJewelryDetailSchema = z.object({
  jewelryItemType: z.string(),
  description: z.string().nullable(),
  quantity: z.number(),
  remainingQty: z.number().nullable(),
  metal: z.string().nullable(),
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

export const ImsInventoryItemSchema = z.object({
  id: z.string(),
  sku: z.string(),
  vendorSku: z.string().nullable(),
  itemName: z.string().nullable(),
  itemType: ItemTypeSchema,
  itemSubtype: ItemSubtypeSchema.nullable(),
  status: ItemStatusSchema,
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
  photoCount: z.number(),
  hasVideo: z.boolean(),
  stone: ImsStoneDetailSchema.nullable(),
  jewelry: ImsJewelryDetailSchema.nullable(),
  material: ImsOtherMaterialDetailSchema.nullable()
});
export type ImsInventoryItem = z.infer<typeof ImsInventoryItemSchema>;

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
  inventoryItemCount: z.number(),
  openDocumentCount: z.number()
});
export type ImsVendor = z.infer<typeof ImsVendorSchema>;

export const ImsCreateVendorSchema = z.object({
  name: z.string().trim().min(1),
  contactName: z.string().nullable().optional(),
  contactEmail: z.string().nullable().optional(),
  contactPhone: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  defaultMemoTermsDays: z.number().int().positive().nullable().optional(),
  defaultInvoiceTermsDays: z.number().int().positive().nullable().optional(),
  quickbooksId: z.string().nullable().optional(),
  notes: z.string().optional()
});
export type ImsCreateVendor = z.infer<typeof ImsCreateVendorSchema>;

export const ImsUpdateVendorSchema = z.object({
  name: z.string().trim().min(1).optional(),
  contactName: z.string().nullable().optional(),
  contactEmail: z.string().nullable().optional(),
  contactPhone: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  defaultMemoTermsDays: z.number().int().positive().nullable().optional(),
  defaultInvoiceTermsDays: z.number().int().positive().nullable().optional(),
  quickbooksId: z.string().nullable().optional(),
  notes: z.string().optional()
});
export type ImsUpdateVendor = z.infer<typeof ImsUpdateVendorSchema>;

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

export const ImsInventoryQuerySchema = z.object({
  type: ItemTypeSchema.optional(),
  status: ItemStatusSchema.optional(),
  q: z.string().trim().min(1).optional(),
  visible: z.enum(["true", "false"]).optional()
});
export type ImsInventoryQuery = z.infer<typeof ImsInventoryQuerySchema>;

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
  retailPricePerCt: z.number().nullable().optional(),
  photo1Url: z.string().nullable().optional(),
  photo2Url: z.string().nullable().optional(),
  videoUrl: z.string().nullable().optional()
});
export type ImsStoneDetailInput = z.infer<typeof ImsStoneDetailInputSchema>;

export const ImsJewelryDetailInputSchema = z.object({
  jewelryItemType: z.string().min(1),
  description: z.string().nullable().optional(),
  quantity: z.number().int().positive().optional(),
  metal: z.string().nullable().optional(),
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

const coreCreateFields = {
  vendorId: z.string().min(1).optional(),
  brandOwnerId: z.string().min(1).optional(),
  itemName: z.string().optional(),
  vendorSku: z.string().optional(),
  notes: z.string().optional(),
  visibleOnPortal: z.boolean().optional()
};

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

export const ImsReserveItemSchema = z.object({ clientId: z.string().min(1) });
export type ImsReserveItem = z.infer<typeof ImsReserveItemSchema>;

export const ImsCreateVocabularySchema = z.object({
  kind: z.enum(VOCAB_KINDS),
  value: z.string().trim().min(1)
});
export type ImsCreateVocabulary = z.infer<typeof ImsCreateVocabularySchema>;

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

export const ImsAdjustParcelRemainingSchema = z.object({
  remainingCt: z.number().nonnegative(),
  remainingQty: z.number().int().nonnegative().nullable().optional(),
  reason: z.string().trim().min(1)
});
export type ImsAdjustParcelRemaining = z.infer<typeof ImsAdjustParcelRemainingSchema>;

export const ImsDocumentLineDrawSchema = z.object({
  inventoryItemId: z.string().min(1),
  caratWeight: z.number().positive().optional(),
  quantity: z.number().int().positive().optional(),
  clientReference: z.string().trim().max(200).optional()
});
export type ImsDocumentLineDraw = z.infer<typeof ImsDocumentLineDrawSchema>;

/** A plain calendar day — no clock, no zone. Midday UTC is the round-trip probe
 *  so a date can never drift across a day boundary while being checked. */
const calendarDate = (label: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${label} must be a calendar date (YYYY-MM-DD)`)
    .refine((s) => new Date(`${s}T12:00:00.000Z`).toISOString().slice(0, 10) === s, {
      message: `${label} is not a real calendar date`
    });

export const ImsIssueDateSchema = calendarDate("Issue date");

export const ImsCreateDocumentSchema = z
  .object({
    type: z.enum(["MEMO_OUT", "INVOICE", "BRAND_INVENTORY_OUT"]),
    clientId: z.string().min(1),
    issueDate: ImsIssueDateSchema.optional(),
    inventoryItemIds: z.array(z.string().min(1)).min(1).optional(),
    lines: z.array(ImsDocumentLineDrawSchema).min(1).optional(),
    discountAmount: z.number().nonnegative().optional(),
    notes: z.string().optional()
  })
  .refine((d) => (d.lines?.length ?? 0) > 0 || (d.inventoryItemIds?.length ?? 0) > 0, {
    message: "Provide lines or inventoryItemIds",
    path: ["lines"]
  });
export type ImsCreateDocument = z.infer<typeof ImsCreateDocumentSchema>;

export const ImsRecordReturnSchema = z.object({
  inventoryItemIds: z.array(z.string().min(1)).optional()
});
export type ImsRecordReturn = z.infer<typeof ImsRecordReturnSchema>;

export const ImsCreatePurchaseOrderSchema = z.object({
  vendorId: z.string().min(1),
  issueDate: ImsIssueDateSchema.optional(),
  inventoryItemIds: z.array(z.string().min(1)).min(1),
  discountAmount: z.number().nonnegative().optional(),
  notes: z.string().optional()
});
export type ImsCreatePurchaseOrder = z.infer<typeof ImsCreatePurchaseOrderSchema>;

const inboundItemCoreFields = {
  sku: z.string().optional(),
  itemName: z.string().optional(),
  vendorSku: z.string().optional(),
  notes: z.string().optional(),
  visibleOnPortal: z.boolean().optional()
};

export const ImsInboundItemInputSchema = z.discriminatedUnion("itemType", [
  z.object({
    itemType: z.literal("STONE"),
    itemSubtype: ItemSubtypeSchema.optional(),
    ...inboundItemCoreFields,
    stone: ImsStoneDetailInputSchema
  }),
  z.object({
    itemType: z.literal("JEWELRY"),
    ...inboundItemCoreFields,
    jewelry: ImsJewelryDetailInputSchema
  }),
  z.object({
    itemType: z.literal("OTHER_MATERIAL"),
    ...inboundItemCoreFields,
    material: ImsOtherMaterialDetailInputSchema
  })
]);
export type ImsInboundItemInput = z.infer<typeof ImsInboundItemInputSchema>;

export const ImsCreateInboundDocumentSchema = z
  .object({
    type: z.enum(["BILL_IN", "MEMO_IN", "BRAND_INVENTORY_IN"]),
    vendorId: z.string().min(1).optional(),
    brandOwnerId: z.string().min(1).optional(),
    issueDate: ImsIssueDateSchema.optional(),
    externalReference: z.string().optional(),
    notes: z.string().optional(),
    items: z.array(ImsInboundItemInputSchema).min(1)
  })
  .refine((d) => d.type !== "BRAND_INVENTORY_IN" || !!d.brandOwnerId, {
    message: "A Brand In requires a brand owner.",
    path: ["brandOwnerId"]
  })
  .refine((d) => d.type !== "BRAND_INVENTORY_IN" || !d.vendorId, {
    message: "A Brand In is addressed to a brand owner, not a vendor.",
    path: ["vendorId"]
  })
  .refine((d) => d.type === "BRAND_INVENTORY_IN" || !!d.vendorId, {
    message: "A Bill In / Memo In requires a vendor.",
    path: ["vendorId"]
  })
  .refine((d) => d.type === "BRAND_INVENTORY_IN" || !d.brandOwnerId, {
    message: "Only a Brand In carries a brand owner.",
    path: ["brandOwnerId"]
  });
export type ImsCreateInboundDocument = z.infer<typeof ImsCreateInboundDocumentSchema>;

export const IMS_CSV_CATEGORIES = ["diamonds", "gems", "jewelry", "other"] as const;
export const ImsCsvCategorySchema = z.enum(IMS_CSV_CATEGORIES);
export type ImsCsvCategory = z.infer<typeof ImsCsvCategorySchema>;

export const ImsParseInboundCsvSchema = z
  .object({
    category: ImsCsvCategorySchema,
    csv: z.string().min(1).optional(),
    fileBase64: z.string().min(1).optional(),
    fileName: z.string().max(255).optional(),
    vendorId: z.string().min(1).optional(),
    enrichGia: z.boolean().optional()
  })
  .refine((d) => (d.csv ? 1 : 0) + (d.fileBase64 ? 1 : 0) === 1, {
    message: "Provide either pasted CSV rows or an uploaded file"
  });
export type ImsParseInboundCsv = z.infer<typeof ImsParseInboundCsvSchema>;

export type ImsCsvGiaState = "enriched" | "notFound" | "skipped" | "notConfigured" | "error";
export interface ImsCsvGiaOutcome {
  state: ImsCsvGiaState;
  message: string | null;
  reportNumber: string | null;
  appliedFields: string[];
}

export interface ImsCsvRestockOutcome {
  existingItemId: string;
  currentCt: number | null;
  currentQty: number | null;
  addedCt: number | null;
  addedQty: number | null;
  vendorName: string | null;
  vendorDiffers: boolean;
}

export interface ImsCsvRowResult {
  rowNumber: number;
  sku: string | null;
  ok: boolean;
  error: string | null;
  item: ImsInboundItemInput | null;
  gia?: ImsCsvGiaOutcome | null;
  restock?: ImsCsvRestockOutcome | null;
}
export interface ImsParseInboundCsvResult {
  category: ImsCsvCategory;
  sheetName: string | null;
  totalRows: number;
  okCount: number;
  errorCount: number;
  restockCount: number;
  closedCount: number;
  rows: ImsCsvRowResult[];
  items: ImsInboundItemInput[];
}

/**
 * Sending stock OUT in bulk is the mirror of receiving it: the rows name items
 * that already exist rather than describing new ones, so the parse matches
 * instead of creating. Nothing is written — this is a dry run the sender reads
 * before the document is struck.
 */
export const ImsParseOutboundCsvSchema = z
  .object({
    docType: z.enum(["MEMO_OUT", "INVOICE", "BRAND_INVENTORY_OUT"]),
    csv: z.string().min(1).optional(),
    fileBase64: z.string().min(1).optional(),
    fileName: z.string().max(255).optional(),
    /** Narrows the search to one brand's stock, so a bare style number can't
     *  collide with an identical one from another designer. */
    brandOwnerId: z.string().min(1).optional()
  })
  .refine((d) => (d.csv ? 1 : 0) + (d.fileBase64 ? 1 : 0) === 1, {
    message: "Provide either pasted CSV rows or an uploaded file"
  });
export type ImsParseOutboundCsv = z.infer<typeof ImsParseOutboundCsvSchema>;

export type ImsOutboundMatchState =
  | "matched"
  | "notFound"
  | "ambiguous"
  | "unavailable"
  | "duplicate"
  | "badQuantity";

export interface ImsOutboundMatchRow {
  rowNumber: number;
  /** The identifier as it was written in their file, echoed back so a rejected
   *  row can be found and fixed without counting columns. */
  reference: string | null;
  state: ImsOutboundMatchState;
  ok: boolean;
  error: string | null;
  inventoryItemId: string | null;
  sku: string | null;
  label: string | null;
  status: ItemStatus | null;
  /** Pieces (jewelry) or carats (parcel) still on the shelf, null when the item
   *  is atomic and simply moves whole. */
  availableQty: number | null;
  availableCt: number | null;
  requestedQty: number | null;
}

export interface ImsParseOutboundCsvResult {
  docType: "MEMO_OUT" | "INVOICE" | "BRAND_INVENTORY_OUT";
  sheetName: string | null;
  totalRows: number;
  okCount: number;
  errorCount: number;
  rows: ImsOutboundMatchRow[];
  /** Ready to hand straight to createOutboundDocument. */
  lines: ImsDocumentLineDraw[];
}

export const ImsGiaLookupSchema = z.object({
  reportNumber: z.string().trim().min(1)
});
export type ImsGiaLookup = z.infer<typeof ImsGiaLookupSchema>;

export interface ImsGiaPrefill {
  naturalOrLab: StoneType | null;
  gemType: string | null;
  shape: string | null;
  weightCt: number | null;
  color: string | null;
  fancyColor: string | null;
  clarity: string | null;
  cutGrade: string | null;
  polish: string | null;
  symmetry: string | null;
  fluorescence: string | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  depthPct: number | null;
  tablePct: number | null;
  girdle: string | null;
  lab: string | null;
  certNumber: string | null;
  origin: string | null;
  treatment: string | null;
}

export interface ImsGiaLinks {
  pdf: string | null;
  image: string | null;
  proportionsDiagram: string | null;
  plottingDiagram: string | null;
}

export interface ImsGiaLookupResult {
  found: boolean;
  supported: boolean;
  reportNumber: string | null;
  reportDate: string | null;
  reportType: string | null;
  resultType: string | null;
  prefill: ImsGiaPrefill | null;
  links: ImsGiaLinks | null;
  quotaRemaining: number | null;
  error: string | null;
}

export const ImsDocumentIdsSchema = z.object({
  documentIds: z.array(z.string().min(1)).min(1)
});
export type ImsDocumentIds = z.infer<typeof ImsDocumentIdsSchema>;

export const ImsEmailDocumentsSchema = z.object({
  documentIds: z.array(z.string().min(1)).min(1),
  to: z.array(z.email()).min(1),
  subject: z.string().trim().min(1).max(300),
  message: z.string().max(5000).default("")
});
export type ImsEmailDocuments = z.infer<typeof ImsEmailDocumentsSchema>;

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
  internalNotes: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  openDocumentCount: z.number()
});
export type ImsClient = z.infer<typeof ImsClientSchema>;

export const ImsClientQuerySchema = z.object({
  status: ClientStatusSchema.optional(),
  q: z.string().trim().min(1).optional()
});
export type ImsClientQuery = z.infer<typeof ImsClientQuerySchema>;

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

export const ClientLifecycleActionSchema = z.enum([
  "approve",
  "decline",
  "deactivate",
  "reactivate"
]);
export type ClientLifecycleAction = z.infer<typeof ClientLifecycleActionSchema>;

export const ImsClientLifecycleSchema = z.object({ action: ClientLifecycleActionSchema });
export type ImsClientLifecycle = z.infer<typeof ImsClientLifecycleSchema>;

/* -------------------------------------------------------------------------- */
/* Reports (F7 · KAN-13)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Seven read-only views over records that already exist. Every report is a
 * projection of `InventoryItem`, `Document` (+ its lines) or `ItemStatusHistory`
 * — nothing here writes, and no report needs a table or a column of its own.
 */
export const IMS_REPORT_KEYS = [
  "inventory",
  "memo_out",
  "memo_in",
  "po",
  "invoices",
  "bills",
  "history"
] as const;
export const ImsReportKeySchema = z.enum(IMS_REPORT_KEYS);
export type ImsReportKey = z.infer<typeof ImsReportKeySchema>;

/** Which document type each document-shaped report reads. */
export const IMS_REPORT_DOCUMENT_TYPE = {
  memo_out: "MEMO_OUT",
  memo_in: "MEMO_IN",
  po: "PURCHASE_ORDER",
  invoices: "INVOICE",
  bills: "BILL_IN"
} as const satisfies Record<string, DocumentType>;
export type ImsDocumentReportKey = keyof typeof IMS_REPORT_DOCUMENT_TYPE;

export const IMS_REPORT_ROW_LIMIT_DEFAULT = 1000;
export const IMS_REPORT_ROW_LIMIT_MAX = 5000;

/**
 * One query shape for all seven; each report uses the fields that mean something
 * to it and ignores the rest. Not every filter applies everywhere — `itemStatus`
 * is meaningless on an invoice report, `documentStatus` on an inventory one —
 * so a filter a report cannot honour is simply not applied rather than an error.
 *
 * Defaults are the report's own question: **current** inventory excludes SOLD and
 * RETURNED, and a document report excludes VOID (a voided document is not
 * business activity). Ask for either explicitly by status and it comes back.
 */
export const ImsReportQuerySchema = z.object({
  /** Inclusive window: issue date (documents), entered-stock date (inventory),
   *  changed-at (history). */
  from: calendarDate("From date").optional(),
  to: calendarDate("To date").optional(),
  /** Free text — SKU / item name (inventory, history), document number /
   *  external reference / party name (documents). */
  q: z.string().trim().min(1).optional(),
  vendorId: z.string().min(1).optional(),
  clientId: z.string().min(1).optional(),
  /** Narrows history to a single item's lifecycle. */
  itemId: z.string().min(1).optional(),
  documentStatus: DocumentStatusSchema.optional(),
  itemStatus: ItemStatusSchema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(IMS_REPORT_ROW_LIMIT_MAX)
    .optional()
    .default(IMS_REPORT_ROW_LIMIT_DEFAULT)
});
export type ImsReportQuery = z.infer<typeof ImsReportQuerySchema>;

/**
 * What every report hands back. `totals` is computed over the rows returned, so
 * when `truncated` is true it describes the page, not the whole table — the flag
 * exists so a caller never reads a capped total as a complete one.
 */
export interface ImsReportEnvelope<K extends ImsReportKey, Totals, Row> {
  key: K;
  /** ISO instant the report was run — also the "today" every age and overdue
   *  count in it was measured against. */
  generatedAt: string;
  rowCount: number;
  truncated: boolean;
  rowLimit: number;
  totals: Totals;
  rows: Row[];
}

export interface ImsInventoryReportRow {
  id: string;
  sku: string;
  vendorSku: string | null;
  itemName: string | null;
  itemType: ItemType;
  itemSubtype: ItemSubtype | null;
  status: ItemStatus;
  vendorName: string | null;
  brandOwnerName: string | null;
  reservedForClientName: string | null;
  /** One-line summary of the piece as it would be quoted. */
  description: string;
  gemType: string | null;
  shape: string | null;
  /** Hue + intensity when the stone is fancy, the white grade otherwise. */
  color: string | null;
  clarity: string | null;
  lab: string | null;
  certNumber: string | null;
  /** What arrived vs what is still on the shelf. They differ only on a lot that
   *  has been part-drawn (parcel carats, jewelry pieces). */
  originalCt: number | null;
  remainingCt: number | null;
  originalQty: number | null;
  remainingQty: number | null;
  /** Valued on the REMAINING balance — a half-sold parcel is worth half. */
  costValue: number | null;
  wholesaleValue: number | null;
  retailValue: number | null;
  visibleOnPortal: boolean;
  enteredStockAt: string;
}

export interface ImsInventoryReportTotals {
  itemCount: number;
  byStatus: Record<ItemStatus, number>;
  byType: Record<ItemType, number>;
  remainingCarats: number;
  costValue: number;
  wholesaleValue: number;
  retailValue: number;
  /** Rows that carried a wholesale figure. The gap against `itemCount` is how
   *  much of the stock is unpriced, which a bare sum would hide. */
  valuedItemCount: number;
}

export type ImsInventoryReport = ImsReportEnvelope<
  "inventory",
  ImsInventoryReportTotals,
  ImsInventoryReportRow
>;

/**
 * One row shape for all five document reports. It deliberately carries only the
 * counterparty's name — no client and no wholesale price — which is what keeps
 * the PO report safe to hand a vendor.
 */
export interface ImsDocumentReportRow {
  id: string;
  type: DocumentType;
  documentNumber: string | null;
  externalReference: string | null;
  status: DocumentStatus;
  direction: DocDirection;
  partyKind: PartyKind | null;
  partyId: string | null;
  partyName: string | null;
  issueDate: string;
  dueDate: string | null;
  /** Calendar days since issue. */
  daysOutstanding: number;
  /** Past its due date and still OPEN. */
  overdue: boolean;
  daysOverdue: number | null;
  lineCount: number;
  /** Lines still out — memo reports only, null where a document type has no
   *  line-level notion of open (an invoice's openness is the document's status). */
  openLineCount: number | null;
  openValue: number | null;
  total: number | null;
  emailedAt: string | null;
  quickbooksSyncedAt: string | null;
}

export interface ImsDocumentReportTotals {
  documentCount: number;
  openCount: number;
  overdueCount: number;
  lineCount: number;
  openLineCount: number | null;
  totalValue: number;
  openValue: number | null;
  /** Never pushed to QuickBooks — the work list for an accounting export. */
  unsyncedCount: number;
}

export type ImsMemoOutReport = ImsReportEnvelope<
  "memo_out",
  ImsDocumentReportTotals,
  ImsDocumentReportRow
>;
export type ImsMemoInReport = ImsReportEnvelope<
  "memo_in",
  ImsDocumentReportTotals,
  ImsDocumentReportRow
>;
export type ImsPurchaseOrderReport = ImsReportEnvelope<
  "po",
  ImsDocumentReportTotals,
  ImsDocumentReportRow
>;
export type ImsInvoiceReport = ImsReportEnvelope<
  "invoices",
  ImsDocumentReportTotals,
  ImsDocumentReportRow
>;
export type ImsBillReport = ImsReportEnvelope<
  "bills",
  ImsDocumentReportTotals,
  ImsDocumentReportRow
>;

export interface ImsItemHistoryReportRow {
  id: string;
  changedAt: string;
  inventoryItemId: string;
  sku: string;
  itemName: string | null;
  itemType: ItemType;
  /** Where the item stands today, so a row read on its own still makes sense. */
  currentStatus: ItemStatus;
  previousStatus: ItemStatus | null;
  newStatus: ItemStatus;
  documentId: string | null;
  documentNumber: string | null;
  documentType: DocumentType | null;
  /** The counterparty on that document — who the piece went to or came from. */
  partyName: string | null;
  changedById: string;
  changedByName: string | null;
  note: string | null;
}

export interface ImsItemHistoryReportTotals {
  eventCount: number;
  /** Distinct items appearing in the rows. */
  itemCount: number;
  byStatus: Record<ItemStatus, number>;
}

export type ImsItemHistoryReport = ImsReportEnvelope<
  "history",
  ImsItemHistoryReportTotals,
  ImsItemHistoryReportRow
>;

export type ImsReport =
  | ImsInventoryReport
  | ImsMemoOutReport
  | ImsMemoInReport
  | ImsPurchaseOrderReport
  | ImsInvoiceReport
  | ImsBillReport
  | ImsItemHistoryReport;
