import { z } from "zod";

import {
  ItemSubtypeSchema,
  ItemTypeSchema,
  JewelryDetailInputSchema,
  OtherMaterialDetailInputSchema,
  StoneDetailInputSchema
} from "./ims";

// ────────────────────────────────────────────────────────────────────────────
// Document wire contract (Phase H4). The IMS records every inventory movement
// as a document (spec §6): a header (party, dates, status, discount, notes) plus
// one or more line items. This file covers the INBOUND documents (H4) — Bill In,
// Memo In, Brand Inventory In — which CREATE the inventory items they list
// (spec §4.4: "New items enter the system via one of three document types … the
// system creates the inventory item record(s), sets status IN_STOCK, auto-
// generates a SKU, logs the status change"). The outbound/return types (H6/H7)
// reuse the same Document/DocumentLineItem tables and the shared engine.
//
// Money/measurements cross the wire as `number | null`; dates as ISO strings.
// ────────────────────────────────────────────────────────────────────────────

const nullableString = z.string().trim().nullable().optional();
const nullableNumber = z.number().nullable().optional();
const nullableInt = z.number().int().nullable().optional();

// ── Enums (mirror schema.prisma) ─────────────────────────────────────────────
export const DocumentTypeSchema = z.enum([
  "BILL_IN",
  "MEMO_IN",
  "BRAND_INVENTORY_IN",
  "MEMO_OUT",
  "CONSIGNMENT_OUT",
  "INVOICE",
  "PURCHASE_ORDER",
  "RETURN_MEMO_OUT",
  "RETURN_MEMO_IN",
  "BRAND_INVENTORY_OUT"
]);
export type DocumentTypeValue = z.infer<typeof DocumentTypeSchema>;

export const DocumentStatusSchema = z.enum(["OPEN", "CLOSED", "EXPORTED", "BILLED", "VOID"]);
export type DocumentStatusValue = z.infer<typeof DocumentStatusSchema>;

export const LineStatusSchema = z.enum([
  "IN_STOCK",
  "ON_MEMO",
  "ON_CONSIGNMENT",
  "SOLD",
  "RETURNED"
]);
export type LineStatusValue = z.infer<typeof LineStatusSchema>;

// The three inbound types H4 can create. (Outbound creation lands H6/H7.)
export const InboundDocumentTypeSchema = z.enum([
  "BILL_IN",
  "MEMO_IN",
  "BRAND_INVENTORY_IN"
]);
export type InboundDocumentTypeValue = z.infer<typeof InboundDocumentTypeSchema>;

// ── Inbound line item ─────────────────────────────────────────────────────────
// Each line CREATES an inventory item (item fields) and records the commercial
// terms of receiving it (line fields). The matching detail block for itemType is
// optional; the service ignores blocks that don't match (mirrors H3 create).
export const InboundLineSchema = z.object({
  // Item creation (status is forced IN_STOCK by the engine; SKU auto-generates
  // when absent; vendor/brandOwner come from the document header).
  sku: z.string().trim().min(1).optional(),
  itemType: ItemTypeSchema,
  itemSubtype: ItemSubtypeSchema.nullable().optional(),
  visibleOnPortal: z.boolean().optional(),
  stone: StoneDetailInputSchema.optional(),
  jewelry: JewelryDetailInputSchema.optional(),
  other: OtherMaterialDetailInputSchema.optional(),

  // Line commercial terms (drive the discount math §6.7).
  quantity: nullableInt,
  caratWeight: nullableNumber,
  unitPrice: nullableNumber,
  totalPrice: nullableNumber,
  discountAmount: nullableNumber,
  notes: nullableString
});
export type InboundLineInput = z.infer<typeof InboundLineSchema>;

// ── Create (inbound) ────────────────────────────────────────────────────────
// Party + dueDate requirements vary by type and are enforced in the service for
// friendly per-field errors:
//   BILL_IN            → vendorId required
//   MEMO_IN            → vendorId + dueDate required
//   BRAND_INVENTORY_IN → clientId (brand owner) required
// Inbound docs carry the vendor's own number in externalReference; documentNumber
// stays null (Jennifer 2026-06-23 — "not ours to assign").
export const CreateInboundDocumentSchema = z.object({
  type: InboundDocumentTypeSchema,
  vendorId: z.string().optional(),
  clientId: z.string().optional(),
  externalReference: nullableString,
  issueDate: z.string().datetime().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  projectJob: nullableString,
  discountAmount: nullableNumber,
  notes: nullableString,
  // BILL_IN only: link an existing open PO so it's marked BILLED (§6.4).
  linkedPoId: z.string().optional(),
  lines: z.array(InboundLineSchema).min(1, "At least one line item is required")
});
export type CreateInboundDocumentBody = z.infer<typeof CreateInboundDocumentSchema>;

// ── List ───────────────────────────────────────────────────────────────────
export const DOCUMENT_SORT_KEYS = ["newest", "oldest", "due-asc", "due-desc"] as const;
export type DocumentSortKey = (typeof DOCUMENT_SORT_KEYS)[number];

export type DocumentListParams = {
  type?: DocumentTypeValue;
  status?: DocumentStatusValue;
  vendorId?: string;
  clientId?: string;
  overdueOnly?: boolean; // dueDate < today AND status = OPEN (§reporting)
  query?: string; // matches documentNumber / externalReference
  sort: DocumentSortKey;
  page: number;
  perPage: number;
};

export const DocumentListRowSchema = z.object({
  id: z.string(),
  type: DocumentTypeSchema,
  documentNumber: z.string().nullable(),
  externalReference: z.string().nullable(),
  status: DocumentStatusSchema,
  partyName: z.string().nullable(), // vendor or client name, per type
  issueDate: z.string(),
  dueDate: z.string().nullable(),
  overdue: z.boolean(),
  lineCount: z.number(),
  total: z.number(),
  createdAt: z.string()
});
export type DocumentListRow = z.infer<typeof DocumentListRowSchema>;

export const DocumentListResultSchema = z.object({
  items: z.array(DocumentListRowSchema),
  total: z.number(),
  page: z.number(),
  perPage: z.number(),
  totalPages: z.number()
});
export type DocumentListResult = z.infer<typeof DocumentListResultSchema>;

// ── Detail ───────────────────────────────────────────────────────────────────
export const DocumentLineDtoSchema = z.object({
  id: z.string(),
  inventoryItemId: z.string(),
  sku: z.string(),
  summary: z.string(), // short human label of the item
  lineStatus: LineStatusSchema,
  quantity: z.number().nullable(),
  caratWeight: z.number().nullable(),
  unitPrice: z.number().nullable(),
  totalPrice: z.number().nullable(),
  discountAmount: z.number().nullable(),
  lineTotal: z.number(), // computed: base − line discount (§6.7)
  clientReference: z.string().nullable(),
  notes: z.string().nullable()
});
export type DocumentLineDto = z.infer<typeof DocumentLineDtoSchema>;

export const DocumentTotalsSchema = z.object({
  grossSubtotal: z.number(),
  lineDiscountTotal: z.number(),
  subtotal: z.number(),
  documentDiscount: z.number(),
  total: z.number()
});
export type DocumentTotalsDto = z.infer<typeof DocumentTotalsSchema>;

export const DocumentDetailSchema = z.object({
  id: z.string(),
  type: DocumentTypeSchema,
  documentNumber: z.string().nullable(),
  externalReference: z.string().nullable(),
  status: DocumentStatusSchema,
  vendorId: z.string().nullable(),
  vendorName: z.string().nullable(),
  clientId: z.string().nullable(),
  clientName: z.string().nullable(),
  issueDate: z.string(),
  dueDate: z.string().nullable(),
  projectJob: z.string().nullable(),
  discountAmount: z.number().nullable(),
  notes: z.string().nullable(),
  emailedAt: z.string().nullable(),
  linkedPoId: z.string().nullable(),
  billedPoId: z.string().nullable(),
  overdue: z.boolean(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lines: z.array(DocumentLineDtoSchema),
  totals: DocumentTotalsSchema
});
export type DocumentDetail = z.infer<typeof DocumentDetailSchema>;

// ── Mutation results ──────────────────────────────────────────────────────────
export type DocumentMutationResult =
  | {
      ok: true;
      id: string;
      documentNumber: string | null;
      createdItemIds: string[];
      warning?: string;
    }
  | { ok: false; error: string; issues?: unknown };

export type VoidDocumentResult = { ok: true; id: string } | { ok: false; error: string };
