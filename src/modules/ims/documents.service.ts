import { Prisma, prisma } from "@/db";
import type { CloseReason as PrismaCloseReason } from "@/db";
import type { ImsCreateDocument, ImsDocument, ImsRecordReturn } from "@/contract";

import {
  ALLOWED_SOURCE_STATUS,
  DOC_PREFIX,
  NEW_ITEM_STATUS,
  NEW_LINE_STATUS,
  type OutboundCreateType
} from "./documents.constants";
import { IMS_DOC_INCLUDE, prismaDocToDto } from "./documents.mappers";

export type CreateDocumentResult =
  | { ok: true; document: ImsDocument }
  | { ok: false; error: string };

export type RecordReturnResult =
  | { ok: true; returnDocument: ImsDocument; memo: ImsDocument }
  | { ok: false; error: string };

type ItemWithDetails = Prisma.InventoryItemGetPayload<{
  include: { stone: true; jewelry: true; material: true };
}>;

// One priced line ready to persist, plus the source status we need for the
// ItemStatusHistory audit row.
type LineSnapshot = {
  itemId: string;
  currentStatus: ItemWithDetails["status"];
  quantity: number | null;
  caratWeight: number | null;
  unitPrice: number | null;
  totalPrice: number | null;
};

function num(value: Prisma.Decimal | null): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value.toString());
  return Number.isFinite(n) ? n : null;
}

// Freeze the item's wholesale value onto the line at doc-creation time. Mirrors
// admin twOf(): stones = carat × price-per-carat; jewelry/other = wholesalePrice.
function priceSnapshot(item: ItemWithDetails): {
  quantity: number | null;
  caratWeight: number | null;
  unitPrice: number | null;
  totalPrice: number | null;
} {
  if (item.stone) {
    const carat = num(item.stone.weightCt);
    const ppc = num(item.stone.wholesalePricePerCt);
    const total =
      carat !== null && ppc !== null
        ? Math.round(carat * ppc * 100) / 100
        : num(item.stone.totalWholesalePrice);
    return { quantity: item.stone.quantity, caratWeight: carat, unitPrice: ppc, totalPrice: total };
  }
  if (item.jewelry) {
    const price = num(item.jewelry.wholesalePrice);
    return { quantity: item.jewelry.quantity, caratWeight: null, unitPrice: price, totalPrice: price };
  }
  if (item.material) {
    const price = num(item.material.wholesalePrice);
    return { quantity: item.material.quantity, caratWeight: null, unitPrice: price, totalPrice: price };
  }
  return { quantity: null, caratWeight: null, unitPrice: null, totalPrice: null };
}

export async function createOutboundDocument(
  input: ImsCreateDocument,
  createdById: string
): Promise<CreateDocumentResult> {
  const type = input.type as OutboundCreateType;

  const client = await prisma.company.findUnique({ where: { id: input.clientId } });
  if (!client) return { ok: false, error: "Client not found" };

  // Dedup ids; a stone listed twice would be double-drawn.
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

  const allowed = ALLOWED_SOURCE_STATUS[type];
  const blocked = items.filter((i) => !allowed.includes(i.status));
  if (blocked.length > 0) {
    const detail = blocked.map((i) => `${i.sku} (${i.status})`).join(", ");
    return {
      ok: false,
      error: `Cannot add to a ${type}: item(s) not in ${allowed.join("/")}: ${detail}`
    };
  }

  const snapshots: LineSnapshot[] = items.map((item) => ({
    itemId: item.id,
    currentStatus: item.status,
    ...priceSnapshot(item)
  }));

  const now = new Date();
  const dueDate =
    type === "MEMO_OUT" && client.defaultMemoTermsDays
      ? new Date(now.getTime() + client.defaultMemoTermsDays * 86_400_000)
      : null;

  const newItemStatus = NEW_ITEM_STATUS[type];
  const newLineStatus = NEW_LINE_STATUS[type];

  const docId = await prisma.$transaction(async (tx) => {
    // Mint the per-type number atomically. Default counter is 1000, so the first
    // minted number is 1001 (matches admin nextNum: (seq || 1000) + 1).
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
        issueDate: now,
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
            totalPrice: s.totalPrice
          }))
        }
      }
    });

    // Transition each item and audit it. Status only ever moves through a doc,
    // so every transition gets an ItemStatusHistory row pointing at this doc.
    for (const s of snapshots) {
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

    return doc.id;
  });

  const created = await prisma.document.findUniqueOrThrow({
    where: { id: docId },
    include: IMS_DOC_INCLUDE
  });
  return { ok: true, document: prismaDocToDto(created) };
}

// Record a return against an OPEN Memo Out (admin #0025 / recordMemoReturn):
// create a linked RETURN_MEMO_OUT, resolve the returned memo lines
// (lineStatus RETURNED + resolvedByDocument = the return), put each returned
// stone back to IN_STOCK with an audit row, and auto-close the memo only once no
// line is still ON_MEMO (a partial return leaves it OPEN).
//
// Lifecycle note: a memo return sends the stone back to IN_STOCK (it was never
// sold — it's simply back and available to memo/sell again). visibleOnPortal is
// left as-is (staff re-list deliberately). The distinct ItemStatus.RETURNED is
// reserved for a future post-sale return. Flagged for Jennifer's lifecycle
// rulebook sign-off (memory: #0025).
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

  // Which lines to return: the named items, else everything still out.
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

  const returnedLineIds = new Set(targetLines.map((l) => l.id));

  const returnDocId = await prisma.$transaction(async (tx) => {
    const seq = await tx.documentSequence.upsert({
      where: { type: "RETURN_MEMO_OUT" },
      create: { type: "RETURN_MEMO_OUT", lastValue: 1001 },
      update: { lastValue: { increment: 1 } }
    });
    const documentNumber = `${DOC_PREFIX.RETURN_MEMO_OUT}-${seq.lastValue}`;

    // The return doc is born CLOSED (a return is never "open") with its own
    // RETURNED lines — returnedItemIds derives from these.
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

    // Resolve the memo lines and send each stone back to stock (with an audit row).
    for (const line of targetLines) {
      await tx.documentLineItem.update({
        where: { id: line.id },
        data: { lineStatus: "RETURNED", resolvedByDocumentId: returnDoc.id }
      });
      const item = await tx.inventoryItem.findUniqueOrThrow({
        where: { id: line.inventoryItemId }
      });
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

    // Recompute the memo's disposition from ALL its lines' final state.
    const finalStatuses = memo.lineItems.map((l) =>
      returnedLineIds.has(l.id) ? "RETURNED" : l.lineStatus
    );
    const stillOut = finalStatuses.filter((s) => s === "ON_MEMO").length;
    const returnedCount = finalStatuses.filter((s) => s === "RETURNED").length;
    const soldCount = finalStatuses.filter((s) => s === "SOLD").length;
    const allResolved = stillOut === 0;
    const closeReason: PrismaCloseReason | null = !allResolved
      ? null
      : returnedCount > 0 && soldCount > 0
        ? "MIXED"
        : soldCount > 0
          ? "SOLD"
          : "RETURNED";
    await tx.document.update({
      where: { id: memo.id },
      data: { status: allResolved ? "CLOSED" : "OPEN", closeReason }
    });

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
