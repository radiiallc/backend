import { z } from "zod";

import { RequestTypeSchema } from "./request";

// ────────────────────────────────────────────────────────────────────────────
// Admin wire contract. The admin DTOs use *translated* display enums (ACTIVE,
// PARTIAL, UNDECIDED) distinct from the underlying Prisma/request enums — the
// mappers in apps/api do the translation. Names are Admin-prefixed to avoid
// colliding with the request.ts exports in the contract barrel.
// ────────────────────────────────────────────────────────────────────────────

export const AdminAccountStatusSchema = z.enum(["PENDING", "ACTIVE", "DEACTIVATED", "DECLINED"]);
export type AdminAccountStatus = z.infer<typeof AdminAccountStatusSchema>;

export const AdminRequestStatusSchema = z.enum(["PENDING", "APPROVED", "PARTIAL", "REJECTED"]);
export type AdminRequestStatus = z.infer<typeof AdminRequestStatusSchema>;

export const AdminRequestItemStatusSchema = z.enum(["UNDECIDED", "APPROVED", "REJECTED"]);
export type AdminRequestItemStatus = z.infer<typeof AdminRequestItemStatusSchema>;

export const AdminItemCategorySchema = z.enum(["gemstone", "natural-diamond", "lab-diamond"]);
export type AdminItemCategory = z.infer<typeof AdminItemCategorySchema>;

export const AdminCompanySchema = z.object({
  id: z.string(),
  name: z.string(),
  shippingAddress: z.string(),
  gemstoneMarkupPct: z.number().nullable(),
  naturalDiamondMarkupPct: z.number().nullable(),
  labDiamondMarkupPct: z.number().nullable(),
  internalNotes: z.string()
});
export type AdminCompany = z.infer<typeof AdminCompanySchema>;

export const AdminAccountSchema = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  phone: z.string(),
  location: z.string(),
  referredBy: z.string().nullable(),
  status: AdminAccountStatusSchema,
  signedUpAt: z.string(),
  activeSince: z.string().nullable(),
  companyId: z.string()
});
export type AdminAccount = z.infer<typeof AdminAccountSchema>;

export const AdminRequestItemSchema = z.object({
  id: z.string(),
  sku: z.string(),
  category: AdminItemCategorySchema,
  variety: z.string(),
  shape: z.string(),
  carat: z.number(),
  color: z.string(),
  clarity: z.string().nullable(),
  certNumber: z.string().nullable(),
  vendor: z.string(),
  pricePerCarat: z.number(),
  totalPrice: z.number(),
  status: AdminRequestItemStatusSchema
});
export type AdminRequestItem = z.infer<typeof AdminRequestItemSchema>;

export const AdminRequestSchema = z.object({
  id: z.string(),
  reference: z.string(),
  type: RequestTypeSchema,
  status: AdminRequestStatusSchema,
  companyId: z.string(),
  submittedByAccountId: z.string(),
  submittedAt: z.string(),
  noteFromClient: z.string().nullable(),
  externalNote: z.string(),
  items: z.array(AdminRequestItemSchema)
});
export type AdminRequest = z.infer<typeof AdminRequestSchema>;

export const DashboardKpisSchema = z.object({
  pendingAccounts: z.number(),
  pendingRequests: z.number(),
  requestsThisWeek: z.number(),
  lastIngestRunAt: z.string().nullable(),
  lastIngestRowCount: z.number().nullable()
});
export type DashboardKpis = z.infer<typeof DashboardKpisSchema>;

export const PendingSignupNotificationSchema = z.object({
  id: z.string(),
  fullName: z.string(),
  email: z.string(),
  companyName: z.string(),
  createdAt: z.string()
});
export type PendingSignupNotification = z.infer<typeof PendingSignupNotificationSchema>;

// Admin server-action return shape (optional warning on success).
export type AdminActionResult =
  | { ok: true; warning?: string }
  | { ok: false; error: string };

// ── Mutation request bodies ─────────────────────────────────────────────────
export const DeclineAccountBodySchema = z.object({
  reason: z.string().nullable().optional()
});
export type DeclineAccountBody = z.infer<typeof DeclineAccountBodySchema>;

export const MarkupUpdateBodySchema = z.object({
  gemstoneMarkupPct: z.number().nullable(),
  naturalDiamondMarkupPct: z.number().nullable(),
  labDiamondMarkupPct: z.number().nullable()
});
export type MarkupUpdateBody = z.infer<typeof MarkupUpdateBodySchema>;

export const UpdateInternalNotesBodySchema = z.object({ internalNotes: z.string() });
export type UpdateInternalNotesBody = z.infer<typeof UpdateInternalNotesBodySchema>;

export const UpdateExternalNoteBodySchema = z.object({ externalNote: z.string() });
export type UpdateExternalNoteBody = z.infer<typeof UpdateExternalNoteBodySchema>;
