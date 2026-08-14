import { Prisma, prisma } from "@/db";
import type { ImsCreateVendor, ImsUpdateVendor, ImsVendor } from "@/contract";

import { IMS_VENDOR_INCLUDE, prismaVendorToDto } from "./mappers";

export type VendorMutationResult =
  | { ok: true; vendor: ImsVendor }
  | { ok: false; error: string };

function isUniqueNameViolation(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    e.code === "P2002" &&
    (e.meta?.target as string[] | undefined)?.includes("name") !== false
  );
}

async function loadVendorDto(id: string): Promise<ImsVendor> {
  const v = await prisma.vendor.findUniqueOrThrow({ where: { id }, include: IMS_VENDOR_INCLUDE });
  return prismaVendorToDto(v);
}

export async function createVendor(input: ImsCreateVendor): Promise<VendorMutationResult> {
  try {
    const created = await prisma.vendor.create({
      data: {
        name: input.name,
        contactName: input.contactName ?? null,
        contactEmail: input.contactEmail ?? null,
        contactPhone: input.contactPhone ?? null,
        address: input.address ?? null,
        defaultMemoTermsDays: input.defaultMemoTermsDays ?? null,
        defaultInvoiceTermsDays: input.defaultInvoiceTermsDays ?? null,
        quickbooksId: input.quickbooksId ?? null,
        notes: input.notes ?? ""
      },
      include: IMS_VENDOR_INCLUDE
    });
    return { ok: true, vendor: prismaVendorToDto(created) };
  } catch (e) {
    if (isUniqueNameViolation(e)) {
      return { ok: false, error: `A vendor named "${input.name}" already exists` };
    }
    throw e;
  }
}

export async function updateVendor(
  id: string,
  input: ImsUpdateVendor
): Promise<VendorMutationResult> {
  const existing = await prisma.vendor.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return { ok: false, error: "Vendor not found" };

  const data: Prisma.VendorUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.contactName !== undefined) data.contactName = input.contactName;
  if (input.contactEmail !== undefined) data.contactEmail = input.contactEmail;
  if (input.contactPhone !== undefined) data.contactPhone = input.contactPhone;
  if (input.address !== undefined) data.address = input.address;
  if (input.defaultMemoTermsDays !== undefined) data.defaultMemoTermsDays = input.defaultMemoTermsDays;
  if (input.defaultInvoiceTermsDays !== undefined)
    data.defaultInvoiceTermsDays = input.defaultInvoiceTermsDays;
  if (input.quickbooksId !== undefined) data.quickbooksId = input.quickbooksId;
  if (input.notes !== undefined) data.notes = input.notes;

  try {
    await prisma.vendor.update({ where: { id }, data });
  } catch (e) {
    if (isUniqueNameViolation(e)) {
      return { ok: false, error: `A vendor named "${input.name}" already exists` };
    }
    throw e;
  }
  return { ok: true, vendor: await loadVendorDto(id) };
}
