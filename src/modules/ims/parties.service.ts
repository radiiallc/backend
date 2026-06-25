import { prisma, Prisma } from "@/db";
import type {
  ClientDto,
  CreateClientBody,
  CreateVendorBody,
  PartyMutationResult,
  PartyOption,
  UpdateClientBody,
  UpdateVendorBody,
  VendorDto
} from "@/contract";

// ────────────────────────────────────────────────────────────────────────────
// Vendor + Client services (§5). Minimal CRUD — enough to manage the parties a
// document references. The richer client-portal-user management (spec §5.3) and
// QBO mapping (§10) land later (H8); this is the data layer the document engine
// depends on.
// ────────────────────────────────────────────────────────────────────────────

function dec(d: Prisma.Decimal | null): number | null {
  return d == null ? null : Number(d);
}

// A nullable optional Decimal/number input → Prisma write value. `undefined`
// means "field not provided" (skip on update); `null` means "clear it".
function decIn(v: number | null | undefined): Prisma.Decimal | null | undefined {
  if (v === undefined) return undefined;
  return v === null ? null : new Prisma.Decimal(v);
}

// ── Vendors ────────────────────────────────────────────────────────────────────
function toVendorDto(v: {
  id: string;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  address: string | null;
  defaultMemoTermsDays: number | null;
  quickbooksId: string | null;
  notes: string | null;
  createdAt: Date;
}): VendorDto {
  return {
    id: v.id,
    name: v.name,
    contactName: v.contactName,
    contactEmail: v.contactEmail,
    contactPhone: v.contactPhone,
    address: v.address,
    defaultMemoTermsDays: v.defaultMemoTermsDays,
    quickbooksId: v.quickbooksId,
    notes: v.notes,
    createdAt: v.createdAt.toISOString()
  };
}

export async function listVendors(query?: string): Promise<PartyOption[]> {
  const where: Prisma.VendorWhereInput = query
    ? { name: { contains: query, mode: "insensitive" } }
    : {};
  const rows = await prisma.vendor.findMany({
    where,
    select: { id: true, name: true, defaultMemoTermsDays: true },
    orderBy: { name: "asc" },
    take: 200
  });
  return rows.map((r) => ({ id: r.id, name: r.name, defaultTermsDays: r.defaultMemoTermsDays }));
}

export async function getVendor(id: string): Promise<VendorDto | null> {
  const v = await prisma.vendor.findUnique({ where: { id } });
  return v ? toVendorDto(v) : null;
}

export async function createVendor(body: CreateVendorBody): Promise<PartyMutationResult> {
  try {
    const v = await prisma.vendor.create({
      data: {
        name: body.name,
        contactName: body.contactName ?? null,
        contactEmail: body.contactEmail ?? null,
        contactPhone: body.contactPhone ?? null,
        address: body.address ?? null,
        defaultMemoTermsDays: body.defaultMemoTermsDays ?? null,
        quickbooksId: body.quickbooksId ?? null,
        notes: body.notes ?? null
      },
      select: { id: true }
    });
    return { ok: true, id: v.id };
  } catch (err) {
    return mapPartyError(err, "vendor");
  }
}

export async function updateVendor(
  id: string,
  body: UpdateVendorBody
): Promise<PartyMutationResult> {
  try {
    await prisma.vendor.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.contactName !== undefined ? { contactName: body.contactName } : {}),
        ...(body.contactEmail !== undefined ? { contactEmail: body.contactEmail } : {}),
        ...(body.contactPhone !== undefined ? { contactPhone: body.contactPhone } : {}),
        ...(body.address !== undefined ? { address: body.address } : {}),
        ...(body.defaultMemoTermsDays !== undefined
          ? { defaultMemoTermsDays: body.defaultMemoTermsDays }
          : {}),
        ...(body.quickbooksId !== undefined ? { quickbooksId: body.quickbooksId } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {})
      },
      select: { id: true }
    });
    return { ok: true, id };
  } catch (err) {
    return mapPartyError(err, "vendor");
  }
}

// ── Clients ────────────────────────────────────────────────────────────────────
function toClientDto(c: {
  id: string;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  address: string | null;
  creditLimit: Prisma.Decimal | null;
  defaultTermsDays: number | null;
  quickbooksId: string | null;
  notes: string | null;
  createdAt: Date;
}): ClientDto {
  return {
    id: c.id,
    name: c.name,
    contactName: c.contactName,
    contactEmail: c.contactEmail,
    contactPhone: c.contactPhone,
    address: c.address,
    creditLimit: dec(c.creditLimit),
    defaultTermsDays: c.defaultTermsDays,
    quickbooksId: c.quickbooksId,
    notes: c.notes,
    createdAt: c.createdAt.toISOString()
  };
}

export async function listClients(query?: string): Promise<PartyOption[]> {
  const where: Prisma.ClientWhereInput = query
    ? { name: { contains: query, mode: "insensitive" } }
    : {};
  const rows = await prisma.client.findMany({
    where,
    select: { id: true, name: true, defaultTermsDays: true },
    orderBy: { name: "asc" },
    take: 200
  });
  return rows.map((r) => ({ id: r.id, name: r.name, defaultTermsDays: r.defaultTermsDays }));
}

export async function getClient(id: string): Promise<ClientDto | null> {
  const c = await prisma.client.findUnique({ where: { id } });
  return c ? toClientDto(c) : null;
}

export async function createClient(body: CreateClientBody): Promise<PartyMutationResult> {
  try {
    const c = await prisma.client.create({
      data: {
        name: body.name,
        contactName: body.contactName ?? null,
        contactEmail: body.contactEmail ?? null,
        contactPhone: body.contactPhone ?? null,
        address: body.address ?? null,
        creditLimit: decIn(body.creditLimit) ?? null,
        defaultTermsDays: body.defaultTermsDays ?? null,
        quickbooksId: body.quickbooksId ?? null,
        notes: body.notes ?? null
      },
      select: { id: true }
    });
    return { ok: true, id: c.id };
  } catch (err) {
    return mapPartyError(err, "client");
  }
}

export async function updateClient(
  id: string,
  body: UpdateClientBody
): Promise<PartyMutationResult> {
  try {
    await prisma.client.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.contactName !== undefined ? { contactName: body.contactName } : {}),
        ...(body.contactEmail !== undefined ? { contactEmail: body.contactEmail } : {}),
        ...(body.contactPhone !== undefined ? { contactPhone: body.contactPhone } : {}),
        ...(body.address !== undefined ? { address: body.address } : {}),
        ...(body.creditLimit !== undefined ? { creditLimit: decIn(body.creditLimit) } : {}),
        ...(body.defaultTermsDays !== undefined
          ? { defaultTermsDays: body.defaultTermsDays }
          : {}),
        ...(body.quickbooksId !== undefined ? { quickbooksId: body.quickbooksId } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {})
      },
      select: { id: true }
    });
    return { ok: true, id };
  } catch (err) {
    return mapPartyError(err, "client");
  }
}

function mapPartyError(err: unknown, kind: "vendor" | "client"): PartyMutationResult {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2025") return { ok: false, error: `That ${kind} does not exist.` };
  }
  // eslint-disable-next-line no-console
  console.error(`[ims] ${kind} write failed`, err);
  return { ok: false, error: "Internal error" };
}
