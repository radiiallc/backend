import { Prisma, prisma } from "@/db";
import type { CloseReason as PrismaCloseReason, DocumentType as PrismaDocumentType } from "@/db";
import type {
  ImsCreateDocument,
  ImsCreateInboundDocument,
  ImsCreatePurchaseOrder,
  ImsDocument,
  ImsDocumentLineDraw,
  ImsRecordReturn
} from "@/contract";

import {
  ALLOWED_SOURCE_STATUS,
  DOC_LABEL,
  DOC_PREFIX,
  docDirectionOf,
  NEW_ITEM_STATUS,
  NEW_LINE_STATUS,
  type OutboundCreateType
} from "./documents.constants";
import { IMS_DOC_INCLUDE, prismaDocToDto } from "./documents.mappers";
import { buildInboundItemCreateData, mintSkuBatch } from "./inventory.service";
import {
  matchesJewelryMemoSlice,
  remainingPieces,
  resolveJewelryDraw,
  resolveJewelrySettle,
  reverseJewelryDraw
} from "./jewelry-lot";
import { matchesMemoSlice, type ResolvedDraw, resolveDraw, resolveSettle, reverseDraw } from "./parcel";
import {
  type ExistingItem,
  type RestockPlan,
  RESTOCK_ITEM_SELECT,
  resolveRestock
} from "./restock";

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

function issuedAt(isoDay: string | undefined): Date {
  return isoDay ? new Date(`${isoDay}T12:00:00.000Z`) : new Date();
}

export type CreateDocumentResult =
  | { ok: true; document: ImsDocument }
  | { ok: false; error: string };

export type RecordReturnResult =
  | { ok: true; returnDocument: ImsDocument; memo: ImsDocument }
  | { ok: false; error: string };

export type StampDocumentsResult =
  | { ok: true; documents: ImsDocument[] }
  | { ok: false; error: string };

export type VoidDocumentResult = { ok: true; document: ImsDocument } | { ok: false; error: string };

export type DeleteDocumentResult = { ok: true; summary: string } | { ok: false; error: string };

type ItemWithDetails = Prisma.InventoryItemGetPayload<{
  include: { stone: true; jewelry: true; material: true };
}>;

type LineSnapshot = {
  itemId: string;
  currentStatus: ItemWithDetails["status"];
  draw: ResolvedDraw;
  quantity: number | null;
  caratWeight: number | null;
  unitPrice: number | null;
  totalPrice: number | null;
  clientReference: string | null;
  settlesMemoLineId: string | null;
};

function num(value: Prisma.Decimal | null): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value.toString());
  return Number.isFinite(n) ? n : null;
}

/** A jewelry/material unit price is per PIECE, so a line of 3 is worth 3x it. */
function extend(unitPrice: number | null, quantity: number | null): number | null {
  if (unitPrice === null) return null;
  const qty = quantity ?? 1;
  return Math.round(unitPrice * qty * 100) / 100;
}

function priceSnapshot(
  item: ItemWithDetails,
  draw?: { drawCt: number | null; drawQty: number | null }
): {
  quantity: number | null;
  caratWeight: number | null;
  unitPrice: number | null;
  totalPrice: number | null;
} {
  if (item.stone) {
    const carat = draw?.drawCt ?? num(item.stone.weightCt);
    const qty = draw?.drawCt != null ? draw.drawQty : item.stone.quantity;
    const ppc = num(item.stone.wholesalePricePerCt);
    const total =
      carat !== null && ppc !== null
        ? Math.round(carat * ppc * 100) / 100
        :
          draw?.drawCt != null
          ? null
          : num(item.stone.totalWholesalePrice);
    return { quantity: qty, caratWeight: carat, unitPrice: ppc, totalPrice: total };
  }
  if (item.jewelry) {
    const price = num(item.jewelry.wholesalePrice);
    const qty = draw?.drawQty ?? remainingPieces(item.jewelry);
    return { quantity: qty, caratWeight: null, unitPrice: price, totalPrice: extend(price, qty) };
  }
  if (item.material) {
    const price = num(item.material.wholesalePrice);
    const qty = item.material.quantity;
    return { quantity: qty, caratWeight: null, unitPrice: price, totalPrice: extend(price, qty) };
  }
  return { quantity: null, caratWeight: null, unitPrice: null, totalPrice: null };
}

function costSnapshot(item: ItemWithDetails): {
  quantity: number | null;
  caratWeight: number | null;
  unitPrice: number | null;
  totalPrice: number | null;
} {
  if (item.stone) {
    const carat = num(item.stone.weightCt);
    const cpc = num(item.stone.costPerCt);
    const total =
      carat !== null && cpc !== null
        ? Math.round(carat * cpc * 100) / 100
        : num(item.stone.totalCost);
    return { quantity: item.stone.quantity, caratWeight: carat, unitPrice: cpc, totalPrice: total };
  }
  if (item.jewelry) {
    const cost = num(item.jewelry.productionCost);
    const qty = item.jewelry.quantity;
    return { quantity: qty, caratWeight: null, unitPrice: cost, totalPrice: extend(cost, qty) };
  }
  if (item.material) {
    const cost = num(item.material.cost);
    const qty = item.material.quantity;
    return { quantity: qty, caratWeight: null, unitPrice: cost, totalPrice: extend(cost, qty) };
  }
  return { quantity: null, caratWeight: null, unitPrice: null, totalPrice: null };
}

function detailCostSnapshot(
  kind: "stone" | "jewelry" | "material",
  detail: Record<string, unknown>
): { quantity: number | null; caratWeight: number | null; unitPrice: number | null; totalPrice: number | null } {
  const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  if (kind === "stone") {
    const carat = n(detail.weightCt);
    const cpc = n(detail.costPerCt);
    const total = carat !== null && cpc !== null ? Math.round(carat * cpc * 100) / 100 : n(detail.totalCost);
    return { quantity: n(detail.quantity), caratWeight: carat, unitPrice: cpc, totalPrice: total };
  }
  if (kind === "jewelry") {
    const cost = n(detail.productionCost);
    const qty = n(detail.quantity);
    return { quantity: qty, caratWeight: null, unitPrice: cost, totalPrice: extend(cost, qty) };
  }
  const cost = n(detail.cost);
  const qty = n(detail.quantity);
  return { quantity: qty, caratWeight: null, unitPrice: cost, totalPrice: extend(cost, qty) };
}

async function recomputeMemoClose(tx: Prisma.TransactionClient, memoId: string): Promise<void> {
  const lines = await tx.documentLineItem.findMany({
    where: { documentId: memoId },
    select: { lineStatus: true }
  });
  const stillOut = lines.filter((l) => l.lineStatus === "ON_MEMO").length;
  const soldCount = lines.filter((l) => l.lineStatus === "SOLD").length;
  const returnedCount = lines.filter((l) => l.lineStatus === "RETURNED").length;
  const allResolved = stillOut === 0;
  const closeReason: PrismaCloseReason | null = !allResolved
    ? null
    : returnedCount > 0 && soldCount > 0
      ? "MIXED"
      : soldCount > 0
        ? "SOLD"
        : "RETURNED";
  await tx.document.update({
    where: { id: memoId },
    data: { status: allResolved ? "CLOSED" : "OPEN", closeReason }
  });
}

export async function createOutboundDocument(
  input: ImsCreateDocument,
  createdById: string
): Promise<CreateDocumentResult> {
  const type = input.type as OutboundCreateType;

  const client = await prisma.company.findUnique({ where: { id: input.clientId } });
  if (!client) return { ok: false, error: "Client not found" };

  const requested: ImsDocumentLineDraw[] = input.lines?.length
    ? input.lines
    : (input.inventoryItemIds ?? []).map((id) => ({ inventoryItemId: id }));

  if (requested.length === 0) {
    return { ok: false, error: "A document needs at least one line" };
  }

  const seen = new Set<string>();
  const lines: ImsDocumentLineDraw[] = [];
  for (const line of requested) {
    if (seen.has(line.inventoryItemId)) {
      if (input.lines?.length) {
        return {
          ok: false,
          error: `Item ${line.inventoryItemId} appears twice — combine it into one line`
        };
      }
      continue;
    }
    seen.add(line.inventoryItemId);
    lines.push(line);
  }

  const ids = lines.map((l) => l.inventoryItemId);
  const items = await prisma.inventoryItem.findMany({
    where: { id: { in: ids } },
    include: { stone: true, jewelry: true, material: true }
  });

  if (items.length !== ids.length) {
    const found = new Set(items.map((i) => i.id));
    const missing = ids.filter((id) => !found.has(id));
    return { ok: false, error: `Inventory item(s) not found: ${missing.join(", ")}` };
  }

  const allowed = ALLOWED_SOURCE_STATUS[type];
  const blocked = items.filter((i) => !allowed.includes(i.status));
  if (blocked.length > 0) {
    const detail = blocked.map((i) => `${i.sku} (${i.status})`).join(", ");
    return {
      ok: false,
      error: `Cannot add to a ${type}: item(s) not in ${allowed.join("/")}: ${detail}`
    };
  }

  const memoLineByItem = new Map<string, { id: string; caratWeight: number | null; quantity: number | null }>();
  if (type === "INVOICE") {
    const openMemoLines = await prisma.documentLineItem.findMany({
      where: {
        inventoryItemId: { in: ids },
        lineStatus: "ON_MEMO",
        document: { type: "MEMO_OUT", clientId: input.clientId }
      },
      select: { id: true, inventoryItemId: true, caratWeight: true, quantity: true }
    });
    for (const ml of openMemoLines) {
      const item = items.find((i) => i.id === ml.inventoryItemId);
      const divisible = item != null && (item.itemSubtype === "PARCEL" || item.itemType === "JEWELRY");
      if (!item || !divisible) continue;
      if (memoLineByItem.has(ml.inventoryItemId)) {
        return {
          ok: false,
          error: `${item.sku} is out on more than one open memo to this client — record a return on one of them before invoicing`
        };
      }
      memoLineByItem.set(ml.inventoryItemId, {
        id: ml.id,
        caratWeight: num(ml.caratWeight),
        quantity: ml.quantity
      });
    }
  }

  const byId = new Map(items.map((i) => [i.id, i]));
  const snapshots: LineSnapshot[] = [];
  for (const line of lines) {
    const item = byId.get(line.inventoryItemId)!;
    const memoLine = memoLineByItem.get(item.id);
    const jewelryLot = item.itemType === "JEWELRY" && item.jewelry !== null;

    const settles =
      memoLine != null &&
      (jewelryLot ? matchesJewelryMemoSlice(memoLine, line) : matchesMemoSlice(memoLine, line));

    const resolved = jewelryLot
      ? settles
        ? resolveJewelrySettle(item, memoLine!)
        : resolveJewelryDraw(item, line)
      : settles
        ? resolveSettle(item, memoLine!, line)
        : resolveDraw(item, line);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    snapshots.push({
      itemId: item.id,
      currentStatus: item.status,
      draw: resolved.draw,
      clientReference: line.clientReference?.trim() || null,
      settlesMemoLineId: settles ? memoLine!.id : null,
      ...priceSnapshot(item, resolved.draw)
    });
  }

  const issueDate = issuedAt(input.issueDate);
  const dueDate =
    type === "MEMO_OUT" && client.defaultMemoTermsDays
      ? new Date(issueDate.getTime() + client.defaultMemoTermsDays * 86_400_000)
      : null;

  const newItemStatus = NEW_ITEM_STATUS[type];
  const newLineStatus = NEW_LINE_STATUS[type];

  const docId = await prisma.$transaction(async (tx) => {
    const seq = await tx.documentSequence.upsert({
      where: { type },
      create: { type, lastValue: 1001 },
      update: { lastValue: { increment: 1 } }
    });
    const documentNumber = `${DOC_PREFIX[type]}-${seq.lastValue}`;

    const doc = await tx.document.create({
      data: {
        type,
        documentNumber,
        status: "OPEN",
        clientId: input.clientId,
        issueDate,
        dueDate,
        discountAmount: input.discountAmount ?? null,
        notes: input.notes ?? null,
        createdById,
        lineItems: {
          create: snapshots.map((s) => ({
            inventoryItemId: s.itemId,
            lineStatus: newLineStatus,
            quantity: s.quantity,
            caratWeight: s.caratWeight,
            unitPrice: s.unitPrice,
            totalPrice: s.totalPrice,
            clientReference: s.clientReference
          }))
        }
      }
    });

    for (const s of snapshots) {
      const { draw } = s;

      if (draw.lot === "PARCEL" && draw.remainingAfterCt !== null) {
        await tx.stoneDetail.update({
          where: { inventoryItemId: s.itemId },
          data: { remainingCt: draw.remainingAfterCt, remainingQty: draw.remainingAfterQty }
        });
      } else if (draw.lot === "JEWELRY" && draw.remainingAfterQty !== null) {
        await tx.jewelryDetail.update({
          where: { inventoryItemId: s.itemId },
          data: { remainingQty: draw.remainingAfterQty }
        });
      }

      if (draw.isPartial && !draw.emptied) continue;

      if (s.settlesMemoLineId) {
        const stillOutElsewhere = await tx.documentLineItem.count({
          where: {
            inventoryItemId: s.itemId,
            lineStatus: "ON_MEMO",
            id: { not: s.settlesMemoLineId }
          }
        });
        if (stillOutElsewhere > 0) continue;
      }

      await tx.inventoryItem.update({
        where: { id: s.itemId },
        data: { status: newItemStatus, visibleOnPortal: false }
      });
      await tx.itemStatusHistory.create({
        data: {
          inventoryItemId: s.itemId,
          previousStatus: s.currentStatus,
          newStatus: newItemStatus,
          documentId: doc.id,
          changedById: createdById
        }
      });
    }

    if (type === "INVOICE") {
      const affectedMemoIds = new Set<string>();

      for (const s of snapshots) {
        if (!s.settlesMemoLineId) continue;
        const ml = await tx.documentLineItem.update({
          where: { id: s.settlesMemoLineId },
          data: { lineStatus: "SOLD", resolvedByDocumentId: doc.id }
        });
        affectedMemoIds.add(ml.documentId);
      }

      const soldFromMemo = snapshots.filter(
        (s) => !s.settlesMemoLineId && s.currentStatus === "ON_MEMO"
      );
      for (const s of soldFromMemo) {
        const memoLines = await tx.documentLineItem.findMany({
          where: {
            inventoryItemId: s.itemId,
            lineStatus: "ON_MEMO",
            document: { type: "MEMO_OUT" }
          }
        });
        for (const ml of memoLines) {
          await tx.documentLineItem.update({
            where: { id: ml.id },
            data: { lineStatus: "SOLD", resolvedByDocumentId: doc.id }
          });
          affectedMemoIds.add(ml.documentId);
        }
      }
      for (const memoId of affectedMemoIds) {
        await recomputeMemoClose(tx, memoId);
      }
    }

    return doc.id;
  });

  const created = await prisma.document.findUniqueOrThrow({
    where: { id: docId },
    include: IMS_DOC_INCLUDE
  });
  return { ok: true, document: prismaDocToDto(created) };
}

type VoidableDoc = Prisma.DocumentGetPayload<{
  include: {
    lineItems: { include: { inventoryItem: { include: { stone: true, jewelry: true } } } };
    childDocuments: { select: { id: true } };
  };
}>;

const NOT_VOIDABLE: Partial<Record<PrismaDocumentType, string>> = {
  RETURN_MEMO_OUT:
    "A Return Memo Out is the record of stones coming back — it cannot be voided. Correct it by recording the movement again on a new document.",
  RETURN_MEMO_IN:
    "A Return Memo In is the record of stones going back to the vendor — it cannot be voided. Correct it by recording the movement again on a new document.",
  BRAND_INVENTORY_IN: "Brand In documents cannot be voided yet.",
  BRAND_INVENTORY_OUT: "Brand Out documents cannot be voided yet."
};

export async function voidDocument(
  documentId: string,
  actorId: string
): Promise<VoidDocumentResult> {
  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    include: {
      lineItems: { include: { inventoryItem: { include: { stone: true, jewelry: true } } } },
      childDocuments: { select: { id: true } }
    }
  });
  if (!doc) return { ok: false, error: "Document not found" };

  const label = DOC_LABEL[doc.type];
  const refusal = NOT_VOIDABLE[doc.type];
  if (refusal) return { ok: false, error: refusal };
  if (doc.status === "VOID") return { ok: false, error: "Document is already void" };
  if (doc.quickbooksSyncedAt) {
    return {
      ok: false,
      error: `This ${label} has been synced to QuickBooks — void it there first`
    };
  }
  if (doc.childDocuments.length > 0) {
    return {
      ok: false,
      error: `This ${label} already has a return recorded against it — void the return first`
    };
  }

  if (docDirectionOf(doc.type) === "in") return voidInboundDocument(doc);
  return voidOutboundDocument(doc, actorId);
}

async function voidOutboundDocument(
  doc: VoidableDoc,
  actorId: string
): Promise<VoidDocumentResult> {
  const label = DOC_LABEL[doc.type];

  const resolvedElsewhere = await prisma.documentLineItem.count({
    where: { resolvedByDocumentId: doc.id }
  });
  if (resolvedElsewhere > 0) {
    return {
      ok: false,
      error: `This ${label} sold stones off an open Memo Out — voiding it is not supported yet`
    };
  }
  if (doc.lineItems.some((l) => l.resolvedByDocumentId !== null)) {
    return {
      ok: false,
      error: `Some items on this ${label} have already been returned or sold — voiding it is not supported yet`
    };
  }

  const drewStock = doc.type === "INVOICE" || doc.type === "MEMO_OUT";

  await prisma.$transaction(async (tx) => {
    for (const line of doc.lineItems) {
      const item = line.inventoryItem;
      const stone = item.stone;
      const isParcelLine = drewStock && item.itemSubtype === "PARCEL" && stone !== null;

      if (isParcelLine && stone) {
        const restored = reverseDraw(stone, num(line.caratWeight), line.quantity);
        await tx.stoneDetail.update({
          where: { inventoryItemId: item.id },
          data: { remainingCt: restored.remainingCt, remainingQty: restored.remainingQty }
        });
      } else if (drewStock && item.itemType === "JEWELRY" && item.jewelry) {
        await tx.jewelryDetail.update({
          where: { inventoryItemId: item.id },
          data: { remainingQty: reverseJewelryDraw(item.jewelry, line.quantity) }
        });
      }

      const history = await tx.itemStatusHistory.findFirst({
        where: { inventoryItemId: item.id, documentId: doc.id },
        orderBy: { changedAt: "desc" }
      });
      const priorStatus = history?.previousStatus;
      if (!priorStatus) continue;

      await tx.inventoryItem.update({
        where: { id: item.id },
        data: { status: priorStatus }
      });
      await tx.documentLineItem.update({
        where: { id: line.id },
        data: { lineStatus: priorStatus === "ON_MEMO" ? "ON_MEMO" : "IN_STOCK" }
      });
      await tx.itemStatusHistory.create({
        data: {
          inventoryItemId: item.id,
          previousStatus: history.newStatus,
          newStatus: priorStatus,
          documentId: doc.id,
          changedById: actorId
        }
      });
    }

    await tx.document.update({
      where: { id: doc.id },
      data: { status: "VOID", closeReason: null }
    });
  });

  const updated = await prisma.document.findUniqueOrThrow({
    where: { id: doc.id },
    include: IMS_DOC_INCLUDE
  });
  return { ok: true, document: prismaDocToDto(updated) };
}

async function voidInboundDocument(doc: VoidableDoc): Promise<VoidDocumentResult> {
  const label = DOC_LABEL[doc.type];

  const originRows = await prisma.itemStatusHistory.findMany({
    where: { documentId: doc.id, previousStatus: null },
    select: { inventoryItemId: true }
  });
  const createdIds = originRows.map((r) => r.inventoryItemId);
  const createdSet = new Set(createdIds);

  const restockLines = doc.lineItems.filter((l) => !createdSet.has(l.inventoryItemId));
  if (restockLines.length > 0) {
    const skus = restockLines.slice(0, 3).map((l) => l.inventoryItem.sku);
    const more = restockLines.length > skus.length ? ` and ${restockLines.length - skus.length} more` : "";
    return {
      ok: false,
      error: `This ${label} topped up stock that was already on the shelf (${skus.join(", ")}${more}), which re-averaged those lots' cost. That cannot be undone automatically — adjust those lots by hand instead.`
    };
  }

  const items = await prisma.inventoryItem.findMany({
    where: { id: { in: createdIds } },
    include: {
      stone: { select: { weightCt: true, quantity: true, remainingCt: true, remainingQty: true } },
      _count: { select: { substituteRequestItems: true } }
    }
  });

  const claimedElsewhere = new Set(
    (
      await prisma.documentLineItem.findMany({
        where: {
          inventoryItemId: { in: createdIds },
          documentId: { not: doc.id },
          document: { status: { not: "VOID" } }
        },
        select: { inventoryItemId: true }
      })
    ).map((l) => l.inventoryItemId)
  );

  for (const item of items) {
    if (item.status !== "IN_STOCK") {
      return {
        ok: false,
        error: `${item.sku} has already moved (${item.status.toLowerCase().replace("_", " ")}) since this ${label} was received, so it can no longer be voided. Reverse that movement first.`
      };
    }
    if (claimedElsewhere.has(item.id)) {
      return {
        ok: false,
        error: `${item.sku} appears on another document as well, so this ${label} can no longer be voided. Void that document first.`
      };
    }
    if (item.reservedForClientId) {
      return {
        ok: false,
        error: `${item.sku} is reserved for a client, so this ${label} can no longer be voided. Release the reservation first.`
      };
    }
    if (item._count.substituteRequestItems > 0) {
      return {
        ok: false,
        error: `${item.sku} has been offered to a client as a substitute on a request, so this ${label} can no longer be voided. Remove it from that request first.`
      };
    }
    const stone = item.stone;
    if (stone) {
      const drawnCt = stone.remainingCt !== null && num(stone.remainingCt) !== num(stone.weightCt);
      const drawnQty =
        stone.remainingQty !== null && stone.quantity !== null && stone.remainingQty !== stone.quantity;
      if (drawnCt || drawnQty) {
        return {
          ok: false,
          error: `${item.sku} has already been drawn against, so this ${label} can no longer be voided. Void the document that drew from it first.`
        };
      }
    }
  }

  const count = items.length;
  await prisma.$transaction(
    async (tx) => {
      await tx.documentLineItem.deleteMany({
        where: { OR: [{ documentId: doc.id }, { inventoryItemId: { in: createdIds } }] }
      });
      await tx.inventoryItem.deleteMany({ where: { id: { in: createdIds } } });
      await tx.document.update({
        where: { id: doc.id },
        data: {
          status: "VOID",
          closeReason: null,
          notes: [doc.notes, `Voided — ${count} received item(s) removed from inventory.`]
            .filter(Boolean)
            .join("\n")
        }
      });
    },
    { timeout: 30_000 }
  );

  const updated = await prisma.document.findUniqueOrThrow({
    where: { id: doc.id },
    include: IMS_DOC_INCLUDE
  });
  return { ok: true, document: prismaDocToDto(updated) };
}

export async function deleteDocument(documentId: string): Promise<DeleteDocumentResult> {
  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    include: {
      _count: { select: { lineItems: true, childDocuments: true, resolvedLineItems: true } },
      sourceRequest: { select: { id: true } }
    }
  });
  if (!doc) return { ok: false, error: "Document not found" };

  const label = DOC_LABEL[doc.type];
  const name = doc.documentNumber || doc.externalReference || `this ${label}`;

  if (doc._count.childDocuments > 0) {
    return {
      ok: false,
      error: `${name} has a return recorded against it — delete the return first`
    };
  }
  if (doc._count.resolvedLineItems > 0) {
    return {
      ok: false,
      error: `${name} settled lines on another document — deleting it would leave that document claiming a settlement that no longer exists`
    };
  }
  if (doc.sourceRequest) {
    return {
      ok: false,
      error: `${name} was created from a client request — void it instead, so the request still points at something`
    };
  }
  const movedNothing = doc.status === "VOID" || doc._count.lineItems === 0 || doc.type === "PURCHASE_ORDER";
  if (!movedNothing) {
    return {
      ok: false,
      error: `${name} is holding stock — void it first (that puts the items back), then delete it`
    };
  }

  await prisma.$transaction(async (tx) => {
    await tx.itemStatusHistory.deleteMany({ where: { documentId: doc.id } });
    await tx.documentLineItem.deleteMany({ where: { documentId: doc.id } });
    await tx.document.delete({ where: { id: doc.id } });
  });

  return { ok: true, summary: `${name} deleted` };
}

export async function createPurchaseOrder(
  input: ImsCreatePurchaseOrder,
  createdById: string
): Promise<CreateDocumentResult> {
  const vendor = await prisma.vendor.findUnique({
    where: { id: input.vendorId },
    select: { id: true }
  });
  if (!vendor) return { ok: false, error: "Vendor not found" };

  const ids = Array.from(new Set(input.inventoryItemIds));
  const items = await prisma.inventoryItem.findMany({
    where: { id: { in: ids } },
    include: { stone: true, jewelry: true, material: true }
  });
  if (items.length !== ids.length) {
    const found = new Set(items.map((i) => i.id));
    const missing = ids.filter((id) => !found.has(id));
    return { ok: false, error: `Inventory item(s) not found: ${missing.join(", ")}` };
  }

  const mismatched = items.filter((i) => i.vendorId !== null && i.vendorId !== input.vendorId);
  if (mismatched.length > 0) {
    const detail = mismatched.map((i) => i.sku).join(", ");
    return { ok: false, error: `Item(s) belong to a different vendor: ${detail}` };
  }

  const lines = items.map((item) => ({ itemId: item.id, ...costSnapshot(item) }));
  const issueDate = issuedAt(input.issueDate);

  const docId = await prisma.$transaction(async (tx) => {
    const seq = await tx.documentSequence.upsert({
      where: { type: "PURCHASE_ORDER" },
      create: { type: "PURCHASE_ORDER", lastValue: 1001 },
      update: { lastValue: { increment: 1 } }
    });
    const documentNumber = `${DOC_PREFIX.PURCHASE_ORDER}-${seq.lastValue}`;

    const doc = await tx.document.create({
      data: {
        type: "PURCHASE_ORDER",
        documentNumber,
        status: "OPEN",
        vendorId: input.vendorId,
        issueDate,
        discountAmount: input.discountAmount ?? null,
        notes: input.notes ?? null,
        createdById,
        lineItems: {
          create: lines.map((l) => ({
            inventoryItemId: l.itemId,
            lineStatus: "IN_STOCK" as const,
            quantity: l.quantity,
            caratWeight: l.caratWeight,
            unitPrice: l.unitPrice,
            totalPrice: l.totalPrice
          }))
        }
      }
    });
    return doc.id;
  });

  const created = await prisma.document.findUniqueOrThrow({
    where: { id: docId },
    include: IMS_DOC_INCLUDE
  });
  return { ok: true, document: prismaDocToDto(created) };
}

export async function createInboundDocument(
  input: ImsCreateInboundDocument,
  createdById: string
): Promise<CreateDocumentResult> {
  const isBrandIn = input.type === "BRAND_INVENTORY_IN";
  const issueDate = issuedAt(input.issueDate);

  let owner: { vendorId: string } | { brandOwnerId: string };
  let dueDate: Date | null;
  if (isBrandIn) {
    const brand = await prisma.company.findUnique({
      where: { id: input.brandOwnerId! },
      select: { id: true }
    });
    if (!brand) return { ok: false, error: "Brand owner not found" };
    owner = { brandOwnerId: brand.id };
    dueDate = null;
  } else {
    const vendor = await prisma.vendor.findUnique({
      where: { id: input.vendorId! },
      select: { id: true, defaultMemoTermsDays: true, defaultInvoiceTermsDays: true }
    });
    if (!vendor) return { ok: false, error: "Vendor not found" };
    owner = { vendorId: vendor.id };
    const termDays =
      input.type === "MEMO_IN" ? vendor.defaultMemoTermsDays : vendor.defaultInvoiceTermsDays;
    dueDate = termDays ? new Date(issueDate.getTime() + termDays * 86_400_000) : null;
  }

  const providedSkus = input.items.map((it) => (it.sku ?? "").trim() || null);
  const providedList = providedSkus.filter((s): s is string => s !== null);

  if (new Set(providedList).size !== providedList.length) {
    const seen = new Set<string>();
    const dupes = Array.from(
      new Set(providedList.filter((s) => (seen.has(s) ? true : (seen.add(s), false))))
    );
    return {
      ok: false,
      error: `The upload lists the same RADIIA SKU more than once: ${dupes.join(", ")}. Combine those rows, or receive them on separate documents.`
    };
  }

  const existingBySku = new Map<string, ExistingItem>();
  if (providedList.length > 0) {
    const rows = await prisma.inventoryItem.findMany({
      where: { sku: { in: providedList } },
      select: RESTOCK_ITEM_SELECT
    });
    for (const row of rows) existingBySku.set(row.sku, row);
  }

  const restockPlans = new Map<number, RestockPlan>();
  for (let i = 0; i < input.items.length; i++) {
    const sku = providedSkus[i];
    const existing = sku === null ? undefined : existingBySku.get(sku);
    if (!existing) continue;
    const resolved = resolveRestock(existing, input.items[i]);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    restockPlans.set(i, resolved.plan);
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const docId = await prisma.$transaction(
        async (tx) => {
          const needsMint = providedSkus.filter((s, i) => s === null && !restockPlans.has(i)).length;
          const minted = await mintSkuBatch(tx, needsMint);
          let mi = 0;
          const skus = providedSkus.map((s, i) => (restockPlans.has(i) ? s! : (s ?? minted[mi++])));

          const lines: Array<({ inventoryItemId: string } & ReturnType<typeof costSnapshot>) | null> =
            new Array(input.items.length).fill(null);
          const createdItemIds: string[] = [];
          const restoredItemIds: Array<{ id: string; from: string }> = [];

          type Pending = {
            index: number;
            sku: string;
            core: ReturnType<typeof buildInboundItemCreateData>;
            detailKind: "stone" | "jewelry" | "material";
            detail: Record<string, unknown>;
          };
          const pending: Pending[] = [];

          for (let i = 0; i < input.items.length; i++) {
            const plan = restockPlans.get(i);

            if (plan) {
              if (plan.stoneUpdate) {
                await tx.stoneDetail.update({
                  where: { inventoryItemId: plan.itemId },
                  data: plan.stoneUpdate
                });
              } else if (plan.jewelryUpdate) {
                await tx.jewelryDetail.update({
                  where: { inventoryItemId: plan.itemId },
                  data: plan.jewelryUpdate
                });
              } else if (plan.materialUpdate) {
                await tx.otherMaterialDetail.update({
                  where: { inventoryItemId: plan.itemId },
                  data: plan.materialUpdate
                });
              }
              if (plan.restoreToInStock) {
                await tx.inventoryItem.update({
                  where: { id: plan.itemId },
                  data: { status: "IN_STOCK" }
                });
                restoredItemIds.push({ id: plan.itemId, from: "SOLD" });
              }
              lines[i] = {
                inventoryItemId: plan.itemId,
                quantity: plan.receivedQty,
                caratWeight: plan.receivedCt,
                unitPrice: plan.unitCost,
                totalPrice: plan.totalCost
              };
              continue;
            }

            const data = buildInboundItemCreateData(input.items[i], owner, skus[i]) as Record<
              string,
              unknown
            >;
            const { stone, jewelry, material, ...core } = data;
            const detailKind = stone ? "stone" : jewelry ? "jewelry" : "material";
            const detail = ((stone ?? jewelry ?? material) as { create: Record<string, unknown> }).create;
            pending.push({ index: i, sku: skus[i], core: core as any, detailKind, detail });
          }

          if (pending.length) {
            const createdCore = await tx.inventoryItem.createManyAndReturn({
              data: pending.map((p) => p.core),
              select: { id: true, sku: true }
            });
            const idBySku = new Map(createdCore.map((r) => [r.sku, r.id]));

            const stoneRows: Array<Record<string, unknown>> = [];
            const jewelryRows: Array<Record<string, unknown>> = [];
            const materialRows: Array<Record<string, unknown>> = [];
            for (const p of pending) {
              const id = idBySku.get(p.sku);
              if (!id) throw new Error(`Bulk insert did not return an id for sku ${p.sku}`);
              if (p.detailKind === "stone") stoneRows.push({ inventoryItemId: id, ...p.detail });
              else if (p.detailKind === "jewelry") jewelryRows.push({ inventoryItemId: id, ...p.detail });
              else materialRows.push({ inventoryItemId: id, ...p.detail });

              createdItemIds.push(id);
              lines[p.index] = { inventoryItemId: id, ...detailCostSnapshot(p.detailKind, p.detail) };
            }
            if (stoneRows.length) await tx.stoneDetail.createMany({ data: stoneRows as any });
            if (jewelryRows.length) await tx.jewelryDetail.createMany({ data: jewelryRows as any });
            if (materialRows.length) await tx.otherMaterialDetail.createMany({ data: materialRows as any });
          }

          let documentNumber: string | null = null;
          if (isBrandIn) {
            const seq = await tx.documentSequence.upsert({
              where: { type: input.type },
              create: { type: input.type, lastValue: 1001 },
              update: { lastValue: { increment: 1 } }
            });
            documentNumber = `${DOC_PREFIX[input.type]}-${seq.lastValue}`;
          }

          const doc = await tx.document.create({
            data: {
              type: input.type,
              documentNumber,
              externalReference: input.externalReference ?? null,
              status: "OPEN",
              vendorId: "vendorId" in owner ? owner.vendorId : null,
              clientId: "brandOwnerId" in owner ? owner.brandOwnerId : null,
              issueDate,
              dueDate,
              notes: input.notes ?? null,
              createdById,
              lineItems: {
                create: (lines as Array<{ inventoryItemId: string } & ReturnType<typeof costSnapshot>>).map(
                  (l) => ({
                    inventoryItemId: l.inventoryItemId,
                    lineStatus: "IN_STOCK" as const,
                    quantity: l.quantity,
                    caratWeight: l.caratWeight,
                    unitPrice: l.unitPrice,
                    totalPrice: l.totalPrice
                  })
                )
              }
            }
          });

          if (createdItemIds.length) {
            await tx.itemStatusHistory.createMany({
              data: createdItemIds.map((inventoryItemId) => ({
                inventoryItemId,
                previousStatus: null,
                newStatus: "IN_STOCK" as const,
                documentId: doc.id,
                changedById: createdById
              }))
            });
          }

          if (restoredItemIds.length) {
            await tx.itemStatusHistory.createMany({
              data: restoredItemIds.map(({ id, from }) => ({
                inventoryItemId: id,
                previousStatus: from as ItemWithDetails["status"],
                newStatus: "IN_STOCK" as const,
                documentId: doc.id,
                changedById: createdById
              }))
            });
          }

          return doc.id;
        },
        { timeout: 30_000 }
      );

      const created = await prisma.document.findUniqueOrThrow({
        where: { id: docId },
        include: IMS_DOC_INCLUDE
      });
      return { ok: true, document: prismaDocToDto(created) };
    } catch (e) {
      if (isUniqueViolation(e) && attempt < 2) continue;
      throw e;
    }
  }
  return { ok: false, error: "Could not allocate unique SKUs — please retry" };
}

export async function recordMemoReturn(
  memoId: string,
  input: ImsRecordReturn,
  changedById: string
): Promise<RecordReturnResult> {
  const memo = await prisma.document.findUnique({
    where: { id: memoId },
    include: { lineItems: true }
  });
  if (!memo) return { ok: false, error: "Memo not found" };
  if (memo.type !== "MEMO_OUT") return { ok: false, error: "Document is not a Memo Out" };

  const onMemoLines = memo.lineItems.filter((l) => l.lineStatus === "ON_MEMO");
  if (onMemoLines.length === 0) {
    return { ok: false, error: "This memo has no stones still out to return" };
  }

  let targetLines = onMemoLines;
  if (input.inventoryItemIds && input.inventoryItemIds.length > 0) {
    const wanted = new Set(input.inventoryItemIds);
    targetLines = onMemoLines.filter((l) => wanted.has(l.inventoryItemId));
    const returnable = new Set(onMemoLines.map((l) => l.inventoryItemId));
    const bad = input.inventoryItemIds.filter((id) => !returnable.has(id));
    if (bad.length > 0) {
      return { ok: false, error: `Not on this memo / already resolved: ${bad.join(", ")}` };
    }
  }
  if (targetLines.length === 0) return { ok: false, error: "No matching stones to return" };

  const returnDocId = await prisma.$transaction(async (tx) => {
    const seq = await tx.documentSequence.upsert({
      where: { type: "RETURN_MEMO_OUT" },
      create: { type: "RETURN_MEMO_OUT", lastValue: 1001 },
      update: { lastValue: { increment: 1 } }
    });
    const documentNumber = `${DOC_PREFIX.RETURN_MEMO_OUT}-${seq.lastValue}`;

    const returnDoc = await tx.document.create({
      data: {
        type: "RETURN_MEMO_OUT",
        documentNumber,
        status: "CLOSED",
        clientId: memo.clientId,
        parentDocumentId: memo.id,
        issueDate: new Date(),
        createdById: changedById,
        lineItems: {
          create: targetLines.map((l) => ({
            inventoryItemId: l.inventoryItemId,
            lineStatus: "RETURNED" as const
          }))
        }
      }
    });

    for (const line of targetLines) {
      await tx.documentLineItem.update({
        where: { id: line.id },
        data: { lineStatus: "RETURNED", resolvedByDocumentId: returnDoc.id }
      });
      const item = await tx.inventoryItem.findUniqueOrThrow({
        where: { id: line.inventoryItemId },
        include: { stone: true, jewelry: true }
      });

      if (item.itemSubtype === "PARCEL" && item.stone) {
        const restored = reverseDraw(item.stone, num(line.caratWeight), line.quantity);
        await tx.stoneDetail.update({
          where: { inventoryItemId: item.id },
          data: { remainingCt: restored.remainingCt, remainingQty: restored.remainingQty }
        });
      } else if (item.itemType === "JEWELRY" && item.jewelry) {
        await tx.jewelryDetail.update({
          where: { inventoryItemId: item.id },
          data: { remainingQty: reverseJewelryDraw(item.jewelry, line.quantity) }
        });
      }

      if (item.status === "IN_STOCK") continue;

      await tx.inventoryItem.update({
        where: { id: line.inventoryItemId },
        data: { status: "IN_STOCK" }
      });
      await tx.itemStatusHistory.create({
        data: {
          inventoryItemId: line.inventoryItemId,
          previousStatus: item.status,
          newStatus: "IN_STOCK",
          documentId: returnDoc.id,
          changedById
        }
      });
    }

    await recomputeMemoClose(tx, memo.id);

    return returnDoc.id;
  });

  const [returnDocument, updatedMemo] = await Promise.all([
    prisma.document.findUniqueOrThrow({ where: { id: returnDocId }, include: IMS_DOC_INCLUDE }),
    prisma.document.findUniqueOrThrow({ where: { id: memo.id }, include: IMS_DOC_INCLUDE })
  ]);
  return {
    ok: true,
    returnDocument: prismaDocToDto(returnDocument),
    memo: prismaDocToDto(updatedMemo)
  };
}

const QBO_SYNCABLE_TYPES: PrismaDocumentType[] = ["INVOICE", "BILL_IN"];

async function requireDocuments(
  ids: string[]
): Promise<
  | { ok: true; unique: string[]; docs: { id: string; type: PrismaDocumentType }[] }
  | { ok: false; error: string }
> {
  const unique = Array.from(new Set(ids));
  const docs = await prisma.document.findMany({
    where: { id: { in: unique } },
    select: { id: true, type: true }
  });
  if (docs.length !== unique.length) {
    const found = new Set(docs.map((d) => d.id));
    const missing = unique.filter((id) => !found.has(id));
    return { ok: false, error: `Document(s) not found: ${missing.join(", ")}` };
  }
  return { ok: true, unique, docs };
}

async function reloadDocs(ids: string[]): Promise<ImsDocument[]> {
  const docs = await prisma.document.findMany({
    where: { id: { in: ids } },
    include: IMS_DOC_INCLUDE,
    orderBy: { issueDate: "desc" }
  });
  return docs.map(prismaDocToDto);
}

export async function emailDocuments(ids: string[]): Promise<StampDocumentsResult> {
  const loaded = await requireDocuments(ids);
  if (!loaded.ok) return { ok: false, error: loaded.error };

  await prisma.document.updateMany({
    where: { id: { in: loaded.unique } },
    data: { emailedAt: new Date() }
  });
  return { ok: true, documents: await reloadDocs(loaded.unique) };
}

export async function quickbooksSyncDocuments(ids: string[]): Promise<StampDocumentsResult> {
  const loaded = await requireDocuments(ids);
  if (!loaded.ok) return { ok: false, error: loaded.error };

  const notSyncable = loaded.docs.filter((d) => !QBO_SYNCABLE_TYPES.includes(d.type));
  if (notSyncable.length > 0) {
    const detail = notSyncable.map((d) => `${d.id} (${d.type})`).join(", ");
    return {
      ok: false,
      error: `Only ${QBO_SYNCABLE_TYPES.join("/")} docs sync to QuickBooks: ${detail}`
    };
  }

  await prisma.document.updateMany({
    where: { id: { in: loaded.unique } },
    data: { quickbooksSyncedAt: new Date() }
  });
  return { ok: true, documents: await reloadDocs(loaded.unique) };
}
