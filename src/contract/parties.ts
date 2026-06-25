import { z } from "zod";

// ────────────────────────────────────────────────────────────────────────────
// Parties wire contract (Phase H4). Vendors (suppliers RADIIA sources from) and
// Clients (companies RADIIA does business with / brand owners). Documents
// reference one of these as their party, so the IMS needs at minimum to list +
// create them before any inbound document can be entered. Spec §5.
//
// Money crosses the wire as `number | null` (Prisma Decimal serialized); the
// service converts to/from the Decimal columns. Dates cross as ISO strings.
// ────────────────────────────────────────────────────────────────────────────

const nullableString = z.string().trim().nullable().optional();
const nullableNumber = z.number().nullable().optional();
const nullableInt = z.number().int().nullable().optional();

// ── Vendor ────────────────────────────────────────────────────────────────────
export const CreateVendorSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  contactName: nullableString,
  contactEmail: nullableString,
  contactPhone: nullableString,
  address: nullableString,
  defaultMemoTermsDays: nullableInt,
  quickbooksId: nullableString,
  notes: nullableString
});
export type CreateVendorBody = z.infer<typeof CreateVendorSchema>;

export const UpdateVendorSchema = CreateVendorSchema.partial();
export type UpdateVendorBody = z.infer<typeof UpdateVendorSchema>;

export const VendorDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  contactName: z.string().nullable(),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  address: z.string().nullable(),
  defaultMemoTermsDays: z.number().nullable(),
  quickbooksId: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string()
});
export type VendorDto = z.infer<typeof VendorDtoSchema>;

// ── Client ────────────────────────────────────────────────────────────────────
export const CreateClientSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  contactName: nullableString,
  contactEmail: nullableString,
  contactPhone: nullableString,
  address: nullableString,
  creditLimit: nullableNumber,
  defaultTermsDays: nullableInt,
  quickbooksId: nullableString,
  notes: nullableString
});
export type CreateClientBody = z.infer<typeof CreateClientSchema>;

export const UpdateClientSchema = CreateClientSchema.partial();
export type UpdateClientBody = z.infer<typeof UpdateClientSchema>;

export const ClientDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  contactName: z.string().nullable(),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  address: z.string().nullable(),
  creditLimit: z.number().nullable(),
  defaultTermsDays: z.number().nullable(),
  quickbooksId: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string()
});
export type ClientDto = z.infer<typeof ClientDtoSchema>;

// Trimmed picker row — what a vendor/client dropdown in the document form needs.
export const PartyOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  // Vendor: defaultMemoTermsDays; Client: defaultTermsDays. Lets the document
  // form pre-fill the due date without a second fetch (spec §5.2 / §6.1).
  defaultTermsDays: z.number().nullable()
});
export type PartyOption = z.infer<typeof PartyOptionSchema>;

export type PartyMutationResult =
  | { ok: true; id: string }
  | { ok: false; error: string };
