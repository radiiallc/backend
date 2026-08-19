import { Prisma, prisma } from "@/db";
import type {
  ImsAdjustParcelRemaining,
  ImsCreateInventoryItem,
  ImsInboundItemInput,
  ImsInventoryItem,
  ImsUpdateInventoryItem
} from "@/contract";

import { IMS_ITEM_INCLUDE, prismaItemToDto } from "./mappers";
import { jewelryOpeningBalance } from "./jewelry-lot";
import { parcelOpeningBalance, rebaseUntouchedParcel, resolveAdjust } from "./parcel";

export type CreateItemResult =
  | { ok: true; item: ImsInventoryItem }
  | { ok: false; error: string };

export type UpdateItemResult =
  | { ok: true; item: ImsInventoryItem }
  | { ok: false; error: string };

function decToNum(d: Prisma.Decimal | null): number | null {
  return d === null || d === undefined ? null : Number(d.toString());
}

type PerCt = {
  weightCt: number | null;
  wholesalePricePerCt?: number | null;
  costPerCt?: number | null;
  retailPricePerCt?: number | null;
};

function stoneTotals(p: PerCt): {
  totalWholesalePrice: number | null;
  totalCost: number | null;
  totalRetailPrice: number | null;
} {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const total = (perCt: number | null | undefined) =>
    p.weightCt != null && perCt != null ? round2(p.weightCt * perCt) : null;
  return {
    totalWholesalePrice: total(p.wholesalePricePerCt),
    totalCost: total(p.costPerCt),
    totalRetailPrice: total(p.retailPricePerCt)
  };
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

async function mintSku(): Promise<string> {
  const seq = await prisma.skuSequence.upsert({
    where: { key: "global" },
    create: { key: "global", lastValue: 1001 },
    update: { lastValue: { increment: 1 } }
  });
  return `RAD-0${seq.lastValue}`;
}

export async function mintSkuBatch(
  tx: Prisma.TransactionClient,
  count: number
): Promise<string[]> {
  if (count <= 0) return [];
  const seq = await tx.skuSequence.upsert({
    where: { key: "global" },
    create: { key: "global", lastValue: 1000 + count },
    update: { lastValue: { increment: count } }
  });
  const end = seq.lastValue;
  return Array.from({ length: count }, (_, i) => `RAD-0${end - count + 1 + i}`);
}

export function buildInboundItemCreateData(
  input: ImsInboundItemInput,
  owner: { vendorId: string } | { brandOwnerId: string },
  sku: string
): Prisma.InventoryItemUncheckedCreateInput {
  const core = {
    sku,
    itemType: input.itemType,
    vendorId: "vendorId" in owner ? owner.vendorId : null,
    brandOwnerId: "brandOwnerId" in owner ? owner.brandOwnerId : null,
    itemName: input.itemName ?? null,
    vendorSku: input.vendorSku ?? null,
    notes: input.notes ?? null,
    visibleOnPortal: input.visibleOnPortal ?? false
  };
  if (input.itemType === "STONE") {
    const s = input.stone;
    const totals = stoneTotals(s);
    const opening = parcelOpeningBalance(input.itemSubtype, s);
    return {
      ...core,
      itemSubtype: input.itemSubtype ?? null,
      stone: { create: { ...s, ...totals, ...opening } }
    };
  }
  if (input.itemType === "JEWELRY") {
    const j = input.jewelry;
    return {
      ...core,
      jewelry: { create: { ...j, remainingQty: jewelryOpeningBalance(j.quantity) } }
    };
  }
  return { ...core, material: { create: { ...input.material } } };
}

export async function adjustParcelRemaining(
  id: string,
  input: ImsAdjustParcelRemaining,
  actorId: string
): Promise<UpdateItemResult> {
  const item = await prisma.inventoryItem.findUnique({
    where: { id },
    include: { stone: true }
  });
  if (!item) return { ok: false, error: "Inventory item not found" };

  const resolved = resolveAdjust(item, input);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const previousStatus = item.status;
  const nextStatus = resolved.emptied ? "SOLD" : previousStatus;

  await prisma.$transaction(async (tx) => {
    await tx.stoneDetail.update({
      where: { inventoryItemId: id },
      data: { remainingCt: resolved.remainingCt, remainingQty: resolved.remainingQty }
    });
    if (nextStatus !== previousStatus) {
      await tx.inventoryItem.update({
        where: { id },
        data: { status: nextStatus, visibleOnPortal: false }
      });
    }
    await tx.itemStatusHistory.create({
      data: {
        inventoryItemId: id,
        previousStatus,
        newStatus: nextStatus,
        changedById: actorId,
        note: `Parcel balance adjusted to ${resolved.remainingCt} ct${
          resolved.remainingQty === null ? "" : ` / ${resolved.remainingQty} pc`
        } — ${input.reason}`
      }
    });
  });

  const updated = await prisma.inventoryItem.findUniqueOrThrow({
    where: { id },
    include: IMS_ITEM_INCLUDE
  });
  return { ok: true, item: prismaItemToDto(updated) };
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

export async function createInventoryItem(
  input: ImsCreateInventoryItem
): Promise<CreateItemResult> {
  const partyError = await assertPartiesExist(input.vendorId, input.brandOwnerId);
  if (partyError) return { ok: false, error: partyError };

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
    const totals = stoneTotals(s);
    detail = {
      ...core,
      sku: "",
      itemSubtype: input.itemSubtype ?? null,
      stone: { create: { ...s, ...totals, ...parcelOpeningBalance(input.itemSubtype, s) } }
    };
  } else if (input.itemType === "JEWELRY") {
    detail = {
      ...core,
      sku: "",
      jewelry: {
        create: { ...input.jewelry, remainingQty: jewelryOpeningBalance(input.jewelry.quantity) }
      }
    };
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
      if (isUniqueViolation(e) && attempt < 2) continue;
      throw e;
    }
  }
  return { ok: false, error: "Could not allocate a unique SKU — please retry" };
}

export async function updateInventoryItem(
  id: string,
  input: ImsUpdateInventoryItem
): Promise<UpdateItemResult> {
  const item = await prisma.inventoryItem.findUnique({
    where: { id },
    include: { stone: true, jewelry: true, material: true }
  });
  if (!item) return { ok: false, error: "Inventory item not found" };

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
    const ex = item.stone!;
    const weightCt = input.stone.weightCt ?? decToNum(ex.weightCt);
    const wholesalePricePerCt =
      input.stone.wholesalePricePerCt !== undefined
        ? input.stone.wholesalePricePerCt
        : decToNum(ex.wholesalePricePerCt);
    const costPerCt =
      input.stone.costPerCt !== undefined ? input.stone.costPerCt : decToNum(ex.costPerCt);
    const retailPricePerCt =
      input.stone.retailPricePerCt !== undefined
        ? input.stone.retailPricePerCt
        : decToNum(ex.retailPricePerCt);
    const totals = stoneTotals({ weightCt, wholesalePricePerCt, costPerCt, retailPricePerCt });
    const rebased = rebaseUntouchedParcel(
      input.itemSubtype !== undefined ? input.itemSubtype : item.itemSubtype,
      ex,
      weightCt,
      input.stone.quantity
    );
    data.stone = { update: { ...input.stone, ...totals, ...rebased } };
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
