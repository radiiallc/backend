import { z } from "zod";

export const RequestTypeSchema = z.enum(["MEMO", "INVOICE"]);
export type RequestType = z.infer<typeof RequestTypeSchema>;

export const RequestStatusSchema = z.enum([
  "PENDING",
  "UNDER_REVIEW",
  "APPROVED",
  "PARTIALLY_APPROVED",
  "REJECTED"
]);
export type RequestStatus = z.infer<typeof RequestStatusSchema>;

export const RequestItemStatusSchema = z.enum(["PENDING", "APPROVED", "REJECTED"]);
export type RequestItemStatus = z.infer<typeof RequestItemStatusSchema>;

export const SubmitRequestBodySchema = z.object({
  type: RequestTypeSchema,
  cartItemIds: z.array(z.string().min(1)).min(1, "Select at least one item to submit"),
  note: z
    .string()
    .trim()
    .max(2000, "Note is too long")
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null))
});
export type SubmitRequestInput = z.input<typeof SubmitRequestBodySchema>;

export type SubmitRequestResult =
  | { ok: true; requestId: string; reference: string; warning?: string }
  | { ok: false; error: string };

export const BuyerRequestListItemSchema = z.object({
  id: z.string(),
  reference: z.string(),
  type: RequestTypeSchema,
  status: RequestStatusSchema,
  submittedAt: z.string(),
  reviewedAt: z.string().nullable(),
  itemCount: z.number(),
  totalUsd: z.number()
});
export type BuyerRequestListItem = z.infer<typeof BuyerRequestListItemSchema>;

export const BuyerRequestDetailItemSchema = z.object({
  id: z.string(),
  itemId: z.string().nullable(),
  sku: z.string(),
  status: RequestItemStatusSchema,
  qty: z.number(),
  unitPriceUsd: z.number().nullable(),
  totalPriceUsd: z.number(),
  variety: z.string(),
  shape: z.string(),
  color: z.string(),
  weightCt: z.number().nullable(),
  certLab: z.string().nullable(),
  certNumber: z.string().nullable(),
  origin: z.string().nullable(),
  treatment: z.string().nullable()
});
export type BuyerRequestDetailItem = z.infer<typeof BuyerRequestDetailItemSchema>;

export const BuyerRequestDetailSchema = z.object({
  id: z.string(),
  reference: z.string(),
  type: RequestTypeSchema,
  status: RequestStatusSchema,
  submittedAt: z.string(),
  reviewedAt: z.string().nullable(),
  note: z.string().nullable(),
  externalNote: z.string().nullable(),
  totalUsd: z.number(),
  approvedTotalUsd: z.number(),
  items: z.array(BuyerRequestDetailItemSchema),
  company: z.object({ name: z.string(), shippingAddress: z.string() })
});
export type BuyerRequestDetail = z.infer<typeof BuyerRequestDetailSchema>;
