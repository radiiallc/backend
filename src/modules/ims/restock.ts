import { Prisma, prisma } from "@/db";
import type { ImsInboundItemInput, ImsParseInboundCsvResult } from "@/contract";

import { remainingPieces } from "./jewelry-lot";
import { remainingOf, round3 } from "./parcel";

const EPS = 1e-6;

type StoneRow = {
  weightCt: Prisma.Decimal;
  quantity: number | null;
  remainingCt: Prisma.Decimal | null;
  remainingQty: number | null;
  costPerCt: Prisma.Decimal | null;
  wholesalePricePerCt: Prisma.Decimal | null;
  retailPricePerCt: Prisma.Decimal | null;
};

type JewelryRow = {
  quantity: number;
  remainingQty: number | null;
  productionCost: Prisma.Decimal;
  wholesalePrice: Prisma.Decimal | null;
  retailPrice: Prisma.Decimal | null;
};

type MaterialRow = {
  quantity: number;
  cost: Prisma.Decimal;
  wholesalePrice: Prisma.Decimal | null;
};

export type ExistingItem = {
  id: string;
  sku: string;
  itemType: string;
  itemSubtype: string | null;
  status: string;
  vendorId: string | null;
  stone: StoneRow | null;
  jewelry: JewelryRow | null;
  material: MaterialRow | null;
};

export type RestockPlan = {
  itemId: string;
  sku: string;
  receivedCt: number | null;
  receivedQty: number | null;
  unitCost: number | null;
  totalCost: number | null;
  restoreToInStock: boolean;
  stoneUpdate: Prisma.StoneDetailUpdateInput | null;
  jewelryUpdate: Prisma.JewelryDetailUpdateInput | null;
  materialUpdate: Prisma.OtherMaterialDetailUpdateInput | null;
};

export type RestockResult = { ok: true; plan: RestockPlan } | { ok: false; error: string };

function num(value: Prisma.Decimal | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value.toString());
  return Number.isFinite(n) ? n : null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function blendRate(
  existingRate: number | null,
  existingAmount: number,
  incomingRate: number | null,
  incomingAmount: number
): number | null {
  if (existingRate === null && incomingRate === null) return null;
  if (existingRate === null) return incomingRate;
  if (incomingRate === null) return existingRate;
  const total = existingAmount + incomingAmount;
  if (total <= EPS) return incomingRate;
  return round2((existingRate * existingAmount + incomingRate * incomingAmount) / total);
}

function addCounts(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b;
}

function incoming<T>(value: T | null | undefined, existing: T | null): T | null {
  return value === undefined || value === null ? existing : value;
}

export function resolveRestock(existing: ExistingItem, input: ImsInboundItemInput): RestockResult {
  if (existing.itemType !== input.itemType) {
    return {
      ok: false,
      error: `${existing.sku} is already in stock as ${existing.itemType.toLowerCase()}, but this row is ${input.itemType.toLowerCase()} — same SKU, different goods`
    };
  }

  const restoreToInStock = existing.status === "SOLD";

  if (input.itemType === "STONE") {
    if (!existing.stone) {
      return { ok: false, error: `${existing.sku}: stone record is missing, cannot add to it` };
    }
    if (existing.itemSubtype !== "PARCEL" || input.itemSubtype !== "PARCEL") {
      return {
        ok: false,
        error: `${existing.sku} is a ${(existing.itemSubtype ?? "single").toLowerCase()}, not a parcel — an individual stone cannot be topped up. Give the new stone its own SKU.`
      };
    }

    const incomingCt = num(input.stone.weightCt);
    if (incomingCt === null || incomingCt <= 0) {
      return { ok: false, error: `${existing.sku}: carat weight must be greater than zero to add to stock` };
    }

    const existingCt = num(existing.stone.weightCt) ?? 0;
    const stock = remainingOf(existing.stone);
    const incomingQty = input.stone.quantity ?? null;

    const weightCt = round3(existingCt + incomingCt);
    const quantity = addCounts(existing.stone.quantity, incomingQty);
    const remainingCt = round3(stock.ct + incomingCt);
    const remainingQty = addCounts(stock.qty, incomingQty);

    const costPerCt = blendRate(
      num(existing.stone.costPerCt),
      existingCt,
      num(input.stone.costPerCt),
      incomingCt
    );
    const wholesalePricePerCt = incoming(
      input.stone.wholesalePricePerCt,
      num(existing.stone.wholesalePricePerCt)
    );
    const retailPricePerCt = incoming(
      input.stone.retailPricePerCt,
      num(existing.stone.retailPricePerCt)
    );

    const total = (perCt: number | null) => (perCt === null ? null : round2(weightCt * perCt));
    const receivedUnitCost = num(input.stone.costPerCt);

    return {
      ok: true,
      plan: {
        itemId: existing.id,
        sku: existing.sku,
        receivedCt: incomingCt,
        receivedQty: incomingQty,
        unitCost: receivedUnitCost,
        totalCost: receivedUnitCost === null ? null : round2(incomingCt * receivedUnitCost),
        restoreToInStock,
        stoneUpdate: {
          weightCt,
          quantity,
          remainingCt,
          remainingQty,
          costPerCt,
          wholesalePricePerCt,
          retailPricePerCt,
          totalCost: total(costPerCt),
          totalWholesalePrice: total(wholesalePricePerCt),
          totalRetailPrice: total(retailPricePerCt)
        },
        jewelryUpdate: null,
        materialUpdate: null
      }
    };
  }

  if (input.itemType === "JEWELRY") {
    if (!existing.jewelry) {
      return { ok: false, error: `${existing.sku}: jewelry record is missing, cannot add to it` };
    }
    const incomingQty = input.jewelry.quantity ?? 1;
    if (incomingQty <= 0) {
      return { ok: false, error: `${existing.sku}: quantity must be greater than zero to add to stock` };
    }
    const existingQty = existing.jewelry.quantity;
    const productionCost = blendRate(
      num(existing.jewelry.productionCost),
      existingQty,
      num(input.jewelry.productionCost),
      incomingQty
    );

    return {
      ok: true,
      plan: {
        itemId: existing.id,
        sku: existing.sku,
        receivedCt: null,
        receivedQty: incomingQty,
        unitCost: num(input.jewelry.productionCost),
        totalCost:
          num(input.jewelry.productionCost) === null
            ? null
            : round2(incomingQty * num(input.jewelry.productionCost)!),
        restoreToInStock,
        stoneUpdate: null,
        jewelryUpdate: {
          quantity: existingQty + incomingQty,
          remainingQty: remainingPieces(existing.jewelry) + incomingQty,
          productionCost: productionCost ?? existing.jewelry.productionCost,
          wholesalePrice: incoming(input.jewelry.wholesalePrice, num(existing.jewelry.wholesalePrice)),
          retailPrice: incoming(input.jewelry.retailPrice, num(existing.jewelry.retailPrice))
        },
        materialUpdate: null
      }
    };
  }

  if (!existing.material) {
    return { ok: false, error: `${existing.sku}: material record is missing, cannot add to it` };
  }
  const incomingQty = input.material.quantity ?? 1;
  if (incomingQty <= 0) {
    return { ok: false, error: `${existing.sku}: quantity must be greater than zero to add to stock` };
  }
  const existingQty = existing.material.quantity;
  const cost = blendRate(
    num(existing.material.cost),
    existingQty,
    num(input.material.cost),
    incomingQty
  );

  return {
    ok: true,
    plan: {
      itemId: existing.id,
      sku: existing.sku,
      receivedCt: null,
      receivedQty: incomingQty,
      unitCost: num(input.material.cost),
      totalCost:
        num(input.material.cost) === null ? null : round2(incomingQty * num(input.material.cost)!),
      restoreToInStock,
      stoneUpdate: null,
      jewelryUpdate: null,
      materialUpdate: {
        quantity: existingQty + incomingQty,
        cost: cost ?? existing.material.cost,
        wholesalePrice: incoming(input.material.wholesalePrice, num(existing.material.wholesalePrice))
      }
    }
  };
}

export async function annotateRestocks(
  result: ImsParseInboundCsvResult,
  receivingVendorId: string | null
): Promise<ImsParseInboundCsvResult> {
  const skus = result.rows.filter((r) => r.ok && r.sku).map((r) => r.sku as string);
  if (skus.length === 0) return { ...result, restockCount: 0 };

  const rows = await prisma.inventoryItem.findMany({
    where: { sku: { in: skus } },
    select: { ...RESTOCK_ITEM_SELECT, vendor: { select: { name: true } } }
  });
  const bySku = new Map(rows.map((r) => [r.sku, r]));

  let restockCount = 0;
  const annotated = result.rows.map((row) => {
    if (!row.ok || !row.sku || !row.item) return row;
    const existing = bySku.get(row.sku);
    if (!existing) return row;

    const resolved = resolveRestock(existing, row.item);
    if (!resolved.ok) {
      return { ...row, ok: false, error: resolved.error, item: null, restock: null };
    }

    restockCount++;
    const stock = existing.stone ? remainingOf(existing.stone) : null;
    return {
      ...row,
      restock: {
        existingItemId: existing.id,
        currentCt: stock ? stock.ct : null,
        currentQty: stock
          ? stock.qty
          : (existing.jewelry?.quantity ?? existing.material?.quantity ?? null),
        addedCt: resolved.plan.receivedCt,
        addedQty: resolved.plan.receivedQty,
        vendorName: existing.vendor?.name ?? null,
        vendorDiffers:
          receivingVendorId !== null &&
          existing.vendorId !== null &&
          existing.vendorId !== receivingVendorId
      }
    };
  });

  const okCount = annotated.filter((r) => r.ok).length;
  return {
    ...result,
    rows: annotated,
    items: annotated.filter((r) => r.ok && r.item).map((r) => r.item!),
    okCount,
    errorCount: annotated.length - okCount,
    restockCount
  };
}

export const RESTOCK_ITEM_SELECT = {
  id: true,
  sku: true,
  itemType: true,
  itemSubtype: true,
  status: true,
  vendorId: true,
  stone: {
    select: {
      weightCt: true,
      quantity: true,
      remainingCt: true,
      remainingQty: true,
      costPerCt: true,
      wholesalePricePerCt: true,
      retailPricePerCt: true
    }
  },
  jewelry: {
    select: {
      quantity: true,
      remainingQty: true,
      productionCost: true,
      wholesalePrice: true,
      retailPrice: true
    }
  },
  material: { select: { quantity: true, cost: true, wholesalePrice: true } }
} satisfies Prisma.InventoryItemSelect;
