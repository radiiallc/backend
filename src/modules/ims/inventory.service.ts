import { Prisma, prisma } from "@/db";
import type { ImsCreateInventoryItem, ImsInventoryItem, ImsUpdateInventoryItem } from "@/contract";

import { IMS_ITEM_INCLUDE, prismaItemToDto } from "./mappers";

export type CreateItemResult =
  | { ok: true; item: ImsInventoryItem }
  | { ok: false; error: string };

export type UpdateItemResult =
  | { ok: true; item: ImsInventoryItem }
  | { ok: false; error: string };

function decToNum(d: Prisma.Decimal | null): number | null {
  return d === null || d === undefined ? null : Number(d.toString());
}

// Stone totals are app-computed (schema): carat × per-carat, rounded to cents.
// Returns undefined for a leg we can't compute so the caller can decide null.
function stoneTotals(
  weightCt: number | null,
  wholesalePricePerCt: number | null,
  costPerCt: number | null
): { totalWholesalePrice: number | null; totalCost: number | null } {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    totalWholesalePrice:
      weightCt != null && wholesalePricePerCt != null ? round2(weightCt * wholesalePricePerCt) : null,
    totalCost: weightCt != null && costPerCt != null ? round2(weightCt * costPerCt) : null
  };
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

// Auto-mint the next RADIIA SKU. Scans existing RAD-0##### numbers and takes
// max+1 (base 1000 → first 1001), mirroring the admin's auto-generated SKU. The
// sku unique constraint is the real backstop; the create retries on collision.
async function mintSku(): Promise<string> {
  const rows = await prisma.inventoryItem.findMany({
    where: { sku: { startsWith: "RAD-0" } },
    select: { sku: true }
  });
  let max = 1000;
  for (const { sku } of rows) {
    const m = /^RAD-0(\d+)$/.exec(sku);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `RAD-0${max + 1}`;
}

async function assertPartiesExist(
  vendorId: string | null | undefined,
  brandOwnerId: string | null | undefined
): Promise<string | null> {
  if (vendorId) {
    const v = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { id: true } });
    if (!v) return `Vendor not found: ${vendorId}`;
  }
  if (brandOwnerId) {
    const c = await prisma.company.findUnique({ where: { id: brandOwnerId }, select: { id: true } });
    if (!c) return `Brand owner (client) not found: ${brandOwnerId}`;
  }
  return null;
}

// Create one inventory item + its single detail group. Status is always the
// schema default (IN_STOCK) — a manual add never sets status; that moves only
// through documents / reserve-release. No ItemStatusHistory row: creation is the
// item's origin, not a status change "through a document".
export async function createInventoryItem(
  input: ImsCreateInventoryItem
): Promise<CreateItemResult> {
  const partyError = await assertPartiesExist(input.vendorId, input.brandOwnerId);
  if (partyError) return { ok: false, error: partyError };

  // Core fields shared by every type (status/enteredStockAt use schema defaults).
  const core = {
    itemType: input.itemType,
    vendorId: input.vendorId ?? null,
    brandOwnerId: input.brandOwnerId ?? null,
    itemName: input.itemName ?? null,
    vendorSku: input.vendorSku ?? null,
    notes: input.notes ?? null,
    visibleOnPortal: input.visibleOnPortal ?? false
  };

  let detail: Prisma.InventoryItemUncheckedCreateInput;
  if (input.itemType === "STONE") {
    const s = input.stone;
    const totals = stoneTotals(s.weightCt, s.wholesalePricePerCt ?? null, s.costPerCt ?? null);
    detail = {
      ...core,
      sku: "", // replaced per attempt below
      itemSubtype: input.itemSubtype ?? null,
      stone: { create: { ...s, ...totals } }
    };
  } else if (input.itemType === "JEWELRY") {
    detail = { ...core, sku: "", jewelry: { create: { ...input.jewelry } } };
  } else {
    detail = { ...core, sku: "", material: { create: { ...input.material } } };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const sku = await mintSku();
    try {
      const created = await prisma.inventoryItem.create({
        data: { ...detail, sku },
        include: IMS_ITEM_INCLUDE
      });
      return { ok: true, item: prismaItemToDto(created) };
    } catch (e) {
      if (isUniqueViolation(e) && attempt < 2) continue; // sku raced — re-mint
      throw e;
    }
  }
  return { ok: false, error: "Could not allocate a unique SKU — please retry" };
}

// Patch an item's core + own-type detail fields. Never changes status (documents
// / reserve-release own that) and never changes itemType. An absent key is left
// unchanged; an explicit null clears a nullable field.
export async function updateInventoryItem(
  id: string,
  input: ImsUpdateInventoryItem
): Promise<UpdateItemResult> {
  const item = await prisma.inventoryItem.findUnique({
    where: { id },
    include: { stone: true, jewelry: true, material: true }
  });
  if (!item) return { ok: false, error: "Inventory item not found" };

  // A detail patch may only target the item's own type.
  if (input.stone && item.itemType !== "STONE")
    return { ok: false, error: "Cannot apply a stone patch to a non-stone item" };
  if (input.jewelry && item.itemType !== "JEWELRY")
    return { ok: false, error: "Cannot apply a jewelry patch to a non-jewelry item" };
  if (input.material && item.itemType !== "OTHER_MATERIAL")
    return { ok: false, error: "Cannot apply a material patch to a non-other item" };

  const partyError = await assertPartiesExist(input.vendorId, input.brandOwnerId);
  if (partyError) return { ok: false, error: partyError };

  const data: Prisma.InventoryItemUncheckedUpdateInput = {};
  if (input.sku !== undefined) data.sku = input.sku;
  if (input.vendorId !== undefined) data.vendorId = input.vendorId;
  if (input.brandOwnerId !== undefined) data.brandOwnerId = input.brandOwnerId;
  if (input.itemName !== undefined) data.itemName = input.itemName;
  if (input.vendorSku !== undefined) data.vendorSku = input.vendorSku;
  if (input.notes !== undefined) data.notes = input.notes;
  if (input.visibleOnPortal !== undefined) data.visibleOnPortal = input.visibleOnPortal;
  if (input.itemSubtype !== undefined) data.itemSubtype = input.itemSubtype;

  if (input.stone) {
    // Recompute totals from the merged (existing ⊕ patch) price/weight so an edit
    // to carat or per-ct keeps the stored totals correct.
    const ex = item.stone!;
    const weightCt = input.stone.weightCt ?? decToNum(ex.weightCt);
    const wholesalePricePerCt =
      input.stone.wholesalePricePerCt !== undefined
        ? input.stone.wholesalePricePerCt
        : decToNum(ex.wholesalePricePerCt);
    const costPerCt =
      input.stone.costPerCt !== undefined ? input.stone.costPerCt : decToNum(ex.costPerCt);
    const totals = stoneTotals(weightCt, wholesalePricePerCt, costPerCt);
    data.stone = { update: { ...input.stone, ...totals } };
  }
  if (input.jewelry) data.jewelry = { update: { ...input.jewelry } };
  if (input.material) data.material = { update: { ...input.material } };

  const updated = await prisma.inventoryItem.update({
    where: { id },
    data,
    include: IMS_ITEM_INCLUDE
  });
  return { ok: true, item: prismaItemToDto(updated) };
}

async function loadItemDto(id: string): Promise<ImsInventoryItem> {
  const item = await prisma.inventoryItem.findUniqueOrThrow({
    where: { id },
    include: IMS_ITEM_INCLUDE
  });
  return prismaItemToDto(item);
}

// Reserve an in-stock item as a hold for a client (admin reserve/hold). This is
// the one non-document status transition, so it still writes an
// ItemStatusHistory audit row (with no documentId). A held stone is pulled from
// the portal. Only an IN_STOCK item can be newly reserved.
export async function reserveItem(
  id: string,
  clientId: string,
  changedById: string
): Promise<UpdateItemResult> {
  const item = await prisma.inventoryItem.findUnique({ where: { id }, select: { status: true } });
  if (!item) return { ok: false, error: "Inventory item not found" };
  if (item.status !== "IN_STOCK") {
    return { ok: false, error: `Only an in-stock item can be reserved (currently ${item.status})` };
  }
  const client = await prisma.company.findUnique({
    where: { id: clientId },
    select: { clientStatus: true }
  });
  if (!client) return { ok: false, error: "Client not found" };
  if (client.clientStatus !== "ACTIVE") return { ok: false, error: "Client is not active" };

  await prisma.$transaction(async (tx) => {
    await tx.inventoryItem.update({
      where: { id },
      data: {
        status: "RESERVED",
        reservedForClientId: clientId,
        reservedAt: new Date(),
        visibleOnPortal: false
      }
    });
    await tx.itemStatusHistory.create({
      data: {
        inventoryItemId: id,
        previousStatus: "IN_STOCK",
        newStatus: "RESERVED",
        changedById
      }
    });
  });
  return { ok: true, item: await loadItemDto(id) };
}

// Release a held item back to stock (admin release). Clears the hold + audits
// it. visibleOnPortal is left as-is (staff re-list deliberately, mirroring a
// memo return). Only a RESERVED item can be released.
export async function releaseItem(id: string, changedById: string): Promise<UpdateItemResult> {
  const item = await prisma.inventoryItem.findUnique({ where: { id }, select: { status: true } });
  if (!item) return { ok: false, error: "Inventory item not found" };
  if (item.status !== "RESERVED") {
    return { ok: false, error: `Only a reserved item can be released (currently ${item.status})` };
  }

  await prisma.$transaction(async (tx) => {
    await tx.inventoryItem.update({
      where: { id },
      data: { status: "IN_STOCK", reservedForClientId: null, reservedAt: null }
    });
    await tx.itemStatusHistory.create({
      data: {
        inventoryItemId: id,
        previousStatus: "RESERVED",
        newStatus: "IN_STOCK",
        changedById
      }
    });
  });
  return { ok: true, item: await loadItemDto(id) };
}
