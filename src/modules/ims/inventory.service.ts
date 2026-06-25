import { prisma, Prisma } from "@/db";
import type {
  CreateInventoryItemBody,
  InventoryMutationResult,
  JewelryDetailInput,
  OtherMaterialDetailInput,
  StoneDetailInput,
  UpdateInventoryItemBody
} from "@/contract";

import { computeDerived } from "./derived";
import { nextSku } from "./sku";

// ────────────────────────────────────────────────────────────────────────────
// Inventory write services (§H3.1). Every status change goes through an
// ItemStatusHistory row (gate §18.15); create writes the first entry. SOLD /
// RETURNED items are force-hidden from the portal regardless of the toggle
// (§4.6 / gate §18.14). SKU is immutable after creation (never mutated on
// parcels — §5 schema note); itemType is fixed (it binds the detail table).
//
// Detail blocks behave differently per op: create writes the full block (absent
// fields → NULL); update is a partial merge (only the keys the client sent are
// written; for stones the derived fields recompute from the merged values).
// ────────────────────────────────────────────────────────────────────────────

// SOLD / RETURNED can never be portal-visible (§4.6). Single chokepoint so the
// rule holds on create, update, and toggle.
function effectiveVisibility(status: string, requested: boolean): boolean {
  if (status === "SOLD" || status === "RETURNED") return false;
  return requested;
}

// ── Create payloads (full; absent → null/default) ────────────────────────────
// Exported so the document engine (H4) can build the same detail blocks for the
// items an inbound document creates — one source of truth for detail shaping.
export function stoneCreateData(
  input: StoneDetailInput
): Prisma.StoneDetailCreateWithoutInventoryItemInput {
  const derived = computeDerived(input);
  return {
    gemType: input.gemType ?? null,
    shape: input.shape ?? null,
    weightCt: input.weightCt ?? null,
    quantity: input.quantity ?? null,
    color: input.color ?? null,
    fancyColor: input.fancyColor ?? null,
    fancyIntensity: input.fancyIntensity ?? null,
    fancyOvertone: input.fancyOvertone ?? null,
    clarity: input.clarity ?? null,
    cutGrade: input.cutGrade ?? null,
    polish: input.polish ?? null,
    symmetry: input.symmetry ?? null,
    fluorescence: input.fluorescence ?? null,
    lengthMm: input.lengthMm ?? null,
    widthMm: input.widthMm ?? null,
    heightMm: input.heightMm ?? null,
    depthPct: input.depthPct ?? null,
    tablePct: input.tablePct ?? null,
    girdle: input.girdle ?? null,
    ratio: derived.ratio,
    lab: input.lab ?? "NONE",
    certNumber: input.certNumber ?? null,
    certUrl: input.certUrl ?? null,
    naturalOrLab: input.naturalOrLab ?? null,
    origin: input.origin ?? null,
    treatment: input.treatment ?? null,
    wholesalePricePerCt: input.wholesalePricePerCt ?? null,
    costPerCt: input.costPerCt ?? null,
    totalWholesalePrice: derived.totalWholesalePrice,
    totalCost: derived.totalCost
  };
}

export function jewelryCreateData(
  input: JewelryDetailInput
): Prisma.JewelryDetailCreateWithoutInventoryItemInput {
  return {
    brand: input.brand ?? null,
    jewelryItemType: input.jewelryItemType ?? null,
    metal: input.metal ?? null,
    ringSize: input.ringSize ?? null,
    lengthMm: input.lengthMm ?? null,
    productionCost: input.productionCost ?? null,
    wholesalePrice: input.wholesalePrice ?? null,
    retailPrice: input.retailPrice ?? null,
    description: input.description ?? null,
    certNumber: input.certNumber ?? null
  };
}

export function otherCreateData(
  input: OtherMaterialDetailInput
): Prisma.OtherMaterialDetailCreateWithoutInventoryItemInput {
  return {
    subtype: input.subtype ?? null,
    metalType: input.metalType ?? null,
    lengthMm: input.lengthMm ?? null,
    widthMm: input.widthMm ?? null,
    weightGrams: input.weightGrams ?? null,
    quantity: input.quantity ?? null,
    description: input.description ?? null,
    cost: input.cost ?? null
  };
}

// ── Partial-update payloads (only provided keys; never wipe untouched fields) ─
// `set(key)` copies input[key] into the update only when the client sent it
// (value !== undefined). null is a meaningful "clear this field" value.
function pick<T extends object, K extends keyof T>(input: T, keys: readonly K[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) {
    if (input[k] !== undefined) out[k] = input[k];
  }
  return out;
}

const STONE_SCALAR_KEYS = [
  "gemType",
  "shape",
  "weightCt",
  "quantity",
  "color",
  "fancyColor",
  "fancyIntensity",
  "fancyOvertone",
  "clarity",
  "cutGrade",
  "polish",
  "symmetry",
  "fluorescence",
  "lengthMm",
  "widthMm",
  "heightMm",
  "depthPct",
  "tablePct",
  "girdle",
  "lab",
  "certNumber",
  "certUrl",
  "naturalOrLab",
  "origin",
  "treatment",
  "wholesalePricePerCt",
  "costPerCt"
] as const;

const JEWELRY_KEYS = [
  "brand",
  "jewelryItemType",
  "metal",
  "ringSize",
  "lengthMm",
  "productionCost",
  "wholesalePrice",
  "retailPrice",
  "description",
  "certNumber"
] as const;

const OTHER_KEYS = [
  "subtype",
  "metalType",
  "lengthMm",
  "widthMm",
  "weightGrams",
  "quantity",
  "description",
  "cost"
] as const;

type ExistingStoneDerived = {
  lengthMm: Prisma.Decimal | null;
  widthMm: Prisma.Decimal | null;
  weightCt: Prisma.Decimal | null;
  wholesalePricePerCt: Prisma.Decimal | null;
  costPerCt: Prisma.Decimal | null;
};

// Build a stone UPDATE: provided scalar keys + recomputed derived fields. The
// derived recompute uses the *merged* values (incoming overrides existing) so a
// change to just costPerCt still recomputes totalCost from the stored weight.
function stoneUpdateData(
  incoming: StoneDetailInput,
  existing: ExistingStoneDerived
): Prisma.StoneDetailUpdateInput {
  const dec = (d: Prisma.Decimal | null): number | null => (d == null ? null : Number(d));
  const merged = {
    lengthMm: incoming.lengthMm !== undefined ? incoming.lengthMm : dec(existing.lengthMm),
    widthMm: incoming.widthMm !== undefined ? incoming.widthMm : dec(existing.widthMm),
    weightCt: incoming.weightCt !== undefined ? incoming.weightCt : dec(existing.weightCt),
    wholesalePricePerCt:
      incoming.wholesalePricePerCt !== undefined
        ? incoming.wholesalePricePerCt
        : dec(existing.wholesalePricePerCt),
    costPerCt: incoming.costPerCt !== undefined ? incoming.costPerCt : dec(existing.costPerCt)
  };
  const derived = computeDerived(merged);
  return {
    ...pick(incoming, STONE_SCALAR_KEYS),
    ratio: derived.ratio,
    totalWholesalePrice: derived.totalWholesalePrice,
    totalCost: derived.totalCost
  };
}

// ── Mutations ────────────────────────────────────────────────────────────────
export async function createInventoryItem(
  body: CreateInventoryItemBody,
  actingUserId: string
): Promise<InventoryMutationResult> {
  const status = body.status ?? "IN_STOCK";
  const visibleOnPortal = effectiveVisibility(status, body.visibleOnPortal ?? false);

  // itemSubtype only applies to stones; ignore it for other types.
  const itemSubtype = body.itemType === "STONE" ? body.itemSubtype ?? null : null;
  const reservedForClientId = body.reservedForClientId ?? null;

  try {
    const created = await prisma.$transaction(async (tx) => {
      const sku = body.sku ?? (await nextSku(tx));

      const data: Prisma.InventoryItemCreateInput = {
        sku,
        itemType: body.itemType,
        itemSubtype,
        status,
        visibleOnPortal,
        notes: body.notes ?? null,
        ...(body.enteredStockAt ? { enteredStockAt: new Date(body.enteredStockAt) } : {}),
        ...(body.vendorId ? { vendor: { connect: { id: body.vendorId } } } : {}),
        ...(body.brandOwnerId ? { brandOwner: { connect: { id: body.brandOwnerId } } } : {}),
        ...(reservedForClientId && status === "RESERVED"
          ? {
              reservedForClient: { connect: { id: reservedForClientId } },
              reservedAt: new Date()
            }
          : {}),
        statusHistory: {
          create: {
            previousStatus: null,
            newStatus: status,
            changedById: actingUserId,
            notes: "Item created."
          }
        }
      };

      if (body.itemType === "STONE" && body.stone) {
        data.stoneDetail = { create: stoneCreateData(body.stone) };
      } else if (body.itemType === "JEWELRY" && body.jewelry) {
        data.jewelryDetail = { create: jewelryCreateData(body.jewelry) };
      } else if (body.itemType === "OTHER_MATERIAL" && body.other) {
        data.otherMaterialDetail = { create: otherCreateData(body.other) };
      }

      return tx.inventoryItem.create({ data, select: { id: true, sku: true } });
    });

    return { ok: true, id: created.id, sku: created.sku };
  } catch (err) {
    return mapWriteError(err, "create");
  }
}

export async function updateInventoryItem(
  id: string,
  body: UpdateInventoryItemBody
): Promise<InventoryMutationResult> {
  const existing = await prisma.inventoryItem.findUnique({
    where: { id },
    include: { stoneDetail: true }
  });
  if (!existing) return { ok: false, error: "Item not found" };

  // Recompute visibility against the *current* status (force-hide rule still
  // applies even though this endpoint doesn't change status).
  const visibleOnPortal =
    body.visibleOnPortal === undefined
      ? undefined
      : effectiveVisibility(existing.status, body.visibleOnPortal);

  const core: Prisma.InventoryItemUpdateInput = {
    ...(existing.itemType === "STONE" && body.itemSubtype !== undefined
      ? { itemSubtype: body.itemSubtype }
      : {}),
    ...(visibleOnPortal !== undefined ? { visibleOnPortal } : {}),
    ...(body.notes !== undefined ? { notes: body.notes } : {}),
    ...(body.enteredStockAt ? { enteredStockAt: new Date(body.enteredStockAt) } : {}),
    ...(body.vendorId !== undefined
      ? { vendor: body.vendorId ? { connect: { id: body.vendorId } } : { disconnect: true } }
      : {}),
    ...(body.brandOwnerId !== undefined
      ? {
          brandOwner: body.brandOwnerId
            ? { connect: { id: body.brandOwnerId } }
            : { disconnect: true }
        }
      : {})
  };

  try {
    await prisma.$transaction(async (tx) => {
      await tx.inventoryItem.update({ where: { id }, data: core });

      // Detail block — partial-merge with the matching type only. If the row
      // doesn't exist yet (item created without a detail block), create it.
      if (existing.itemType === "STONE" && body.stone) {
        await tx.stoneDetail.upsert({
          where: { inventoryItemId: id },
          create: { inventoryItemId: id, ...stoneCreateData(body.stone) },
          update: stoneUpdateData(body.stone, existing.stoneDetail ?? EMPTY_STONE)
        });
      } else if (existing.itemType === "JEWELRY" && body.jewelry) {
        await tx.jewelryDetail.upsert({
          where: { inventoryItemId: id },
          create: { inventoryItemId: id, ...jewelryCreateData(body.jewelry) },
          update: pick(body.jewelry, JEWELRY_KEYS)
        });
      } else if (existing.itemType === "OTHER_MATERIAL" && body.other) {
        await tx.otherMaterialDetail.upsert({
          where: { inventoryItemId: id },
          create: { inventoryItemId: id, ...otherCreateData(body.other) },
          update: pick(body.other, OTHER_KEYS)
        });
      }
    });

    return { ok: true, id, sku: existing.sku };
  } catch (err) {
    return mapWriteError(err, "update");
  }
}

export async function togglePortalVisibility(
  id: string,
  visibleOnPortal: boolean
): Promise<InventoryMutationResult> {
  const existing = await prisma.inventoryItem.findUnique({
    where: { id },
    select: { id: true, sku: true, status: true }
  });
  if (!existing) return { ok: false, error: "Item not found" };

  const effective = effectiveVisibility(existing.status, visibleOnPortal);
  // Asked to show a SOLD/RETURNED item — refuse loudly rather than silently
  // no-op, so the UI can explain why.
  if (visibleOnPortal && !effective) {
    return { ok: false, error: `A ${existing.status} item cannot be shown on the portal.` };
  }

  await prisma.inventoryItem.update({ where: { id }, data: { visibleOnPortal: effective } });
  return { ok: true, id: existing.id, sku: existing.sku };
}

const EMPTY_STONE: ExistingStoneDerived = {
  lengthMm: null,
  widthMm: null,
  weightCt: null,
  wholesalePricePerCt: null,
  costPerCt: null
};

function mapWriteError(err: unknown, op: "create" | "update"): InventoryMutationResult {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") return { ok: false, error: "That SKU is already in use." };
    if (err.code === "P2025" || err.code === "P2003") {
      return { ok: false, error: "A referenced vendor, client, or item does not exist." };
    }
  }
  // eslint-disable-next-line no-console
  console.error(`[ims] inventory ${op} failed`, err);
  return { ok: false, error: "Internal error" };
}
