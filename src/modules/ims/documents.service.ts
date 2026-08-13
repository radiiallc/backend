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

// The instant a document is issued at. The operator picks a calendar DAY
// (YYYY-MM-DD from the admin's date field); we anchor it at noon UTC so the day
// survives the round-trip — the read mapper serializes with toISOString() and
// the admin slices the first 10 chars, which would roll a UTC-midnight stamp
// back one day for anyone reading it from a western timezone. No date given
// (every pre-existing caller) keeps the old behaviour: the current instant.
// Terms are counted from THIS date, so a back-dated Bill In is due on the day
// the vendor's terms actually run out, not 30 days from data entry.
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

// Delete returns a sentence rather than the document — there is no document left
// to return, and the summary is what the admin shows in its toast.
export type DeleteDocumentResult = { ok: true; summary: string } | { ok: false; error: string };

type ItemWithDetails = Prisma.InventoryItemGetPayload<{
  include: { stone: true; jewelry: true; material: true };
}>;

// One priced line ready to persist, plus the source status we need for the
// ItemStatusHistory audit row and the resolved parcel movement.
type LineSnapshot = {
  itemId: string;
  currentStatus: ItemWithDetails["status"];
  draw: ResolvedDraw;
  quantity: number | null;
  caratWeight: number | null;
  unitPrice: number | null;
  totalPrice: number | null;
  clientReference: string | null;
  // Set when this INVOICE line buys a parcel slice already out on the client's
  // Memo Out. Carries the memo line's id because that specific line is what gets
  // resolved to SOLD — a parcel can be out to several clients at once, so
  // "the memo line for this item" is not unique enough to look up later.
  settlesMemoLineId: string | null;
};

function num(value: Prisma.Decimal | null): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value.toString());
  return Number.isFinite(n) ? n : null;
}

// Freeze the item's wholesale value onto the line at doc-creation time. Mirrors
// admin twOf(): stones = carat × price-per-carat; jewelry/other = wholesalePrice.
//
// `draw` carries the resolved parcel movement (see ./parcel). When it names a
// carat weight, the line prices THAT slice at the parcel's per-carat rate rather
// than the whole lot — 0.40 ct off a 16.76 ct parcel bills 0.40 × price/ct. The
// per-carat rate is fixed per parcel for the pilot, so the parcel's own
// wholesalePricePerCt is the only input.
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
        : // Only fall back to the frozen lot total when this is a whole-item
          // line; on a partial draw it would bill the entire parcel.
          draw?.drawCt != null
          ? null
          : num(item.stone.totalWholesalePrice);
    return { quantity: qty, caratWeight: carat, unitPrice: ppc, totalPrice: total };
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

// Freeze the item's COST (what RADIIA pays the vendor) onto a PO line — the
// vendor-facing basis, never wholesale (a PO export is "vendor-safe: no client /
// wholesale"). Stones = carat × cost-per-carat; jewelry = productionCost; other
// = cost. Mirrors priceSnapshot but on the cost columns.
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
    return { quantity: item.jewelry.quantity, caratWeight: null, unitPrice: cost, totalPrice: cost };
  }
  if (item.material) {
    const cost = num(item.material.cost);
    return { quantity: item.material.quantity, caratWeight: null, unitPrice: cost, totalPrice: cost };
  }
  return { quantity: null, caratWeight: null, unitPrice: null, totalPrice: null };
}

// Same math as costSnapshot, but for a detail row that hasn't been written yet
// (the batched bulk-create path knows these numbers locally — see
// createInboundDocument — and doesn't need a round-trip to re-read what it
// just built).
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
    return { quantity: n(detail.quantity), caratWeight: null, unitPrice: cost, totalPrice: cost };
  }
  const cost = n(detail.cost);
  return { quantity: n(detail.quantity), caratWeight: null, unitPrice: cost, totalPrice: cost };
}

// Recompute a Memo Out's disposition from the CURRENT state of all its lines —
// call inside a tx AFTER those lines have been updated. A memo closes only once
// no line is still ON_MEMO; closeReason derives from the resolved mix (all
// returned / all sold / mixed). Shared by the return path (recordMemoReturn) and
// the invoice-from-memo sold path so the two stay identical (admin #0025).
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

  // Accept either form: the legacy whole-item id list, or per-line draws that
  // can carry a partial carat weight for a parcel. `lines` wins when both are
  // sent. Normalising here keeps one code path below.
  const requested: ImsDocumentLineDraw[] = input.lines?.length
    ? input.lines
    : (input.inventoryItemIds ?? []).map((id) => ({ inventoryItemId: id }));

  if (requested.length === 0) {
    return { ok: false, error: "A document needs at least one line" };
  }

  // A stone listed twice would be double-drawn. The legacy form dedups (the
  // admin has always sent unique ids); the draw form rejects, because two draws
  // of one parcel on one document is ambiguous — the caller should send a single
  // combined carat weight rather than have us silently pick or sum.
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

  // An INVOICE for a parcel slice this client already holds on memo SETTLES that
  // memo rather than drawing again — the carats left the safe when the memo was
  // written. Scoped to the invoice's own client on purpose: two clients can each
  // hold a slice of the same parcel, and settling the wrong one would close a
  // memo whose stones are still out.
  //
  // Only parcels take this route. A single stone out on memo is already handled
  // by the ON_MEMO -> SOLD status flip below, and has no balance to double-draw.
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
      if (!item || item.itemSubtype !== "PARCEL") continue;
      if (memoLineByItem.has(ml.inventoryItemId)) {
        // Two open memos to one client holding slices of one parcel. Which slice
        // is being bought is genuinely ambiguous, and picking one would silently
        // leave the other's carats unaccounted for.
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

  // Resolve every parcel draw against live stock BEFORE opening the transaction,
  // so an over-draw on line 7 rejects the whole document instead of half-writing
  // it.
  const byId = new Map(items.map((i) => [i.id, i]));
  const snapshots: LineSnapshot[] = [];
  for (const line of lines) {
    const item = byId.get(line.inventoryItemId)!;
    // Settle the client's existing slice, or draw fresh carats out of what is
    // left of the lot — the requested weight is what tells the two apart. A
    // client who already holds 4 ct and now buys 2 more gets a real draw, not a
    // refusal.
    const memoLine = memoLineByItem.get(item.id);
    const settles = memoLine != null && matchesMemoSlice(memoLine, line);
    const resolved = settles ? resolveSettle(item, memoLine!, line) : resolveDraw(item, line);
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

    // Transition each item and audit it. Status only ever moves through a doc,
    // so every transition gets an ItemStatusHistory row pointing at this doc.
    //
    // A PARCEL drawn partially is the one case where the item does NOT change
    // status: carats come off the balance and the lot stays IN_STOCK, sellable
    // again tomorrow. It flips only when the last carat leaves.
    for (const s of snapshots) {
      const { draw } = s;

      if (draw.remainingAfterCt !== null) {
        await tx.stoneDetail.update({
          where: { inventoryItemId: s.itemId },
          data: { remainingCt: draw.remainingAfterCt, remainingQty: draw.remainingAfterQty }
        });
      }

      // Partial draw that left stock behind: no status change, so no history row
      // (the document line itself is the record of the movement).
      if (draw.isPartial && !draw.emptied) continue;

      // Settling an emptied parcel only sells it outright if nobody ELSE still
      // holds a slice. Two clients can share a depleted lot; marking it SOLD
      // while the other slice is out would strand stones that still have to come
      // back or be invoiced.
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

    // Invoice-from-memo (admin #0025 lifecycle): when an INVOICE sells a stone
    // that was still ON_MEMO, resolve its originating open memo line to SOLD,
    // linked to this invoice, and recompute that memo's close state. This closes
    // the memo↔invoice coupling gap — the invoice IS the resolving document, the
    // mirror of a return doc resolving a line to RETURNED.
    if (type === "INVOICE") {
      const affectedMemoIds = new Set<string>();

      // A settled parcel slice names the exact line it bought. Resolving by item
      // id instead would sweep up another client's slice of the same lot.
      for (const s of snapshots) {
        if (!s.settlesMemoLineId) continue;
        const ml = await tx.documentLineItem.update({
          where: { id: s.settlesMemoLineId },
          data: { lineStatus: "SOLD", resolvedByDocumentId: doc.id }
        });
        affectedMemoIds.add(ml.documentId);
      }

      // Single stones (and pairs): the item itself was ON_MEMO, and a stone can
      // only ever be on one memo, so resolving by item id is unambiguous here.
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
    lineItems: { include: { inventoryItem: { include: { stone: true } } } };
    childDocuments: { select: { id: true } };
  };
}>;

// Types that have a defined reversal. A return document is itself the record of
// an undo — reversing it means putting stones BACK on a memo that may since have
// closed — and the brand-consignment pair has no movement rules written yet, so
// both refuse by name rather than half-reverse.
const NOT_VOIDABLE: Partial<Record<PrismaDocumentType, string>> = {
  RETURN_MEMO_OUT:
    "A Return Memo Out is the record of stones coming back — it cannot be voided. Correct it by recording the movement again on a new document.",
  RETURN_MEMO_IN:
    "A Return Memo In is the record of stones going back to the vendor — it cannot be voided. Correct it by recording the movement again on a new document.",
  BRAND_INVENTORY_IN: "Brand In documents cannot be voided yet.",
  BRAND_INVENTORY_OUT: "Brand Out documents cannot be voided yet."
};

// Void a document — the undo, and the only way to take a mistake back once a
// document has been saved (Jennifer #0049: "in the case that we make a mistake
// and need to start over").
//
// This matters far more once parcels count down. A whole-item mistake is visible
// and correctable by hand: the wrong stone shows as SOLD. A parcel mistake is
// silent arithmetic — 4.0 ct typed instead of 0.40 takes ten times the stock out
// of a lot and nothing about the row looks wrong afterwards. Without a reverse,
// that carat weight is gone.
//
// What "reverse" means depends on which way the goods moved:
//   outbound (Invoice / Memo Out) — give the stock back: parcels get their
//     carats and pieces returned, whole items get the status they held before
//     this document (read from the audit trail this document itself wrote, so
//     the restore is exact rather than an assumption that everything came from
//     IN_STOCK). A Purchase Order moved nothing, so voiding it only marks it.
//   inbound (Bill In / Memo In) — the goods never arrived, so the inventory this
//     receipt CREATED is deleted outright. See voidInboundDocument.
//
// Either way the document itself is kept and marked VOID: numbering stays
// gap-free and the mistake stays visible instead of vanishing from the record.
export async function voidDocument(
  documentId: string,
  actorId: string
): Promise<VoidDocumentResult> {
  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    include: {
      lineItems: { include: { inventoryItem: { include: { stone: true } } } },
      childDocuments: { select: { id: true } }
    }
  });
  if (!doc) return { ok: false, error: "Document not found" };

  const label = DOC_LABEL[doc.type];
  const refusal = NOT_VOIDABLE[doc.type];
  if (refusal) return { ok: false, error: refusal };
  if (doc.status === "VOID") return { ok: false, error: "Document is already void" };
  if (doc.quickbooksSyncedAt) {
    // Once it has gone to QuickBooks, voiding here would silently desync the two
    // ledgers. Not a concern during the pilot (documents are internal-only until
    // QB is connected) but it must not become one later.
    return {
      ok: false,
      error: `This ${label} has been synced to QuickBooks — void it there first`
    };
  }
  // A return recorded against this document already moved some of its stones
  // back. Reversing underneath that would leave the return pointing at a
  // movement that no longer happened.
  if (doc.childDocuments.length > 0) {
    return {
      ok: false,
      error: `This ${label} already has a return recorded against it — void the return first`
    };
  }

  if (docDirectionOf(doc.type) === "in") return voidInboundDocument(doc);
  return voidOutboundDocument(doc, actorId);
}

// Outbound reversal: Invoice / Memo Out give their stock back; a Purchase Order
// never took any, so it is only marked.
async function voidOutboundDocument(
  doc: VoidableDoc,
  actorId: string
): Promise<VoidDocumentResult> {
  const label = DOC_LABEL[doc.type];

  // A stone this document sold OUT of an open memo had that memo's line resolved
  // to SOLD. Reversing cleanly means reopening the memo, which is a second
  // lifecycle; refuse rather than leave a memo in a wrong state.
  const resolvedElsewhere = await prisma.documentLineItem.count({
    where: { resolvedByDocumentId: doc.id }
  });
  if (resolvedElsewhere > 0) {
    return {
      ok: false,
      error: `This ${label} sold stones off an open Memo Out — voiding it is not supported yet`
    };
  }
  // The mirror case: a line on THIS document has already been settled by a
  // later one (returned, or sold off this memo).
  if (doc.lineItems.some((l) => l.resolvedByDocumentId !== null)) {
    return {
      ok: false,
      error: `Some items on this ${label} have already been returned or sold — voiding it is not supported yet`
    };
  }

  // Only these two draw stock; a PO is an order, not a movement, so its lines
  // must not be "given back" — that would credit parcels with carats they never
  // gave up.
  const drewStock = doc.type === "INVOICE" || doc.type === "MEMO_OUT";

  await prisma.$transaction(async (tx) => {
    for (const line of doc.lineItems) {
      const item = line.inventoryItem;
      const stone = item.stone;
      const isParcelLine = drewStock && item.itemSubtype === "PARCEL" && stone !== null;

      if (isParcelLine && stone) {
        // Give the drawn carats/pieces back to the balance.
        const restored = reverseDraw(stone, num(line.caratWeight), line.quantity);
        await tx.stoneDetail.update({
          where: { inventoryItemId: item.id },
          data: { remainingCt: restored.remainingCt, remainingQty: restored.remainingQty }
        });
      }

      // Restore the status this document changed — but only if it changed one.
      // A partial parcel draw never moved the item, so there is nothing to undo.
      const history = await tx.itemStatusHistory.findFirst({
        where: { inventoryItemId: item.id, documentId: doc.id },
        orderBy: { changedAt: "desc" }
      });
      // previousStatus is nullable (an item's origin row has none). Without a
      // recorded prior status there is nothing to restore to, and guessing
      // IN_STOCK could resurrect a stone that was never in stock.
      const priorStatus = history?.previousStatus;
      if (!priorStatus) continue;

      await tx.inventoryItem.update({
        where: { id: item.id },
        data: { status: priorStatus }
      });
      // The line has to stop claiming it sold the stone. Left as SOLD, this
      // voided line still answers "which document sold RAD-01007?" — and would
      // beat the real invoice when the stone is re-sold the same day.
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

// Inbound reversal (Bill In / Memo In): the goods never arrived, so the stock
// this receipt CREATED is deleted outright rather than moved. There is no status
// that means "this item was never received" — leaving 174 mistaken stones in
// inventory as anything at all is the bug being fixed.
//
// That makes this the most destructive operation in the IMS, so it only proceeds
// when every item is provably untouched since it was received: still IN_STOCK,
// on no other document, unreserved, not offered as a substitute, and — for a
// parcel — not drawn against. One item failing any of those refuses the whole
// void by name, because a half-reversed receipt is worse than none.
//
// Restock lines are refused outright. A receipt that topped up an existing SKU
// re-averaged that lot's cost; the pre-merge cost is not recorded anywhere, so
// "subtract the carats back" would leave a lot valued at a price nobody paid.
// No actor is threaded in: unlike an outbound void, this one writes no audit row
// to attribute — every history row it touches dies with the item it described.
async function voidInboundDocument(doc: VoidableDoc): Promise<VoidDocumentResult> {
  const label = DOC_LABEL[doc.type];

  // Which items this receipt brought into existence. The origin row an inbound
  // create writes (previousStatus null → IN_STOCK, documentId = this doc) is the
  // authoritative marker — a restocked line has no origin row of its own here,
  // because the item was already in stock before this document existed.
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

  // Every LIVE document other than this one that names one of these items. A
  // voided document is excluded on purpose: it holds nothing, and counting it
  // would make a receipt permanently un-voidable after any outbound doc against
  // it had been voided — the exact "we made a mistake, start over" sequence.
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
    // Anything but IN_STOCK means a later document already moved it, so undoing
    // the receipt would delete stock that is currently out on memo or sold.
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
    // A parcel can be drawn down without ever changing status — the silent case
    // the status check above cannot see.
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
      // Lines first: DocumentLineItem.inventoryItemId has no cascade, so the
      // items cannot go while their lines still point at them. That includes
      // lines on OTHER documents — which, by the guard above, can only ever be
      // voided ones. A void doc's line describes a movement that was undone, so
      // it survives no better than the item it names.
      await tx.documentLineItem.deleteMany({
        where: { OR: [{ documentId: doc.id }, { inventoryItemId: { in: createdIds } }] }
      });
      // Deleting the items takes their detail rows and status history with them
      // (both cascade), including the origin rows that referenced this document.
      await tx.inventoryItem.deleteMany({ where: { id: { in: createdIds } } });
      await tx.document.update({
        where: { id: doc.id },
        data: {
          status: "VOID",
          closeReason: null,
          // The line items are gone with the stock, so without this the voided
          // document is a blank shell that no longer says what it undid.
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

// Delete a document outright — the harder half of Jennifer #0049. Void is the
// undo; this is for the document that should not exist at all (a duplicate, a
// test upload), where leaving a VOID shell in the list is itself the clutter.
//
// It deliberately cannot delete anything that moved stock: void it first, which
// reverses the movement, and only then can it be deleted. That ordering is what
// keeps "delete" from being a way to make inventory changes untraceable.
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
  // Request.convertedDocumentId is the link a client sees as "your request became
  // this document". Deleting underneath it strands the request.
  if (doc.sourceRequest) {
    return {
      ok: false,
      error: `${name} was created from a client request — void it instead, so the request still points at something`
    };
  }
  // The whole guard, in one line: a document may only be deleted once it is not
  // holding any stock in place. VOID means it was reversed; no lines means it
  // never held any; a Purchase Order is an order, not a movement.
  const movedNothing = doc.status === "VOID" || doc._count.lineItems === 0 || doc.type === "PURCHASE_ORDER";
  if (!movedNothing) {
    return {
      ok: false,
      error: `${name} is holding stock — void it first (that puts the items back), then delete it`
    };
  }

  await prisma.$transaction(async (tx) => {
    // Both FKs to Document are restrict-on-delete, so the references have to go
    // first. Dropping the audit rows is a real loss of trail — it is the point
    // of a delete, and the reason void is the recommended path everywhere in the
    // UI. They are only ever rows about a document that will not exist.
    await tx.itemStatusHistory.deleteMany({ where: { documentId: doc.id } });
    await tx.documentLineItem.deleteMany({ where: { documentId: doc.id } });
    await tx.document.delete({ where: { id: doc.id } });
  });

  return { ok: true, summary: `${name} deleted` };
}

// Create a Purchase Order — a vendor-addressed outbound doc committing RADIIA to
// buy the listed inventory items from that vendor. Unlike a Memo Out / Invoice, a
// PO does NOT transition item status (it's the order, not a stock movement — the
// eventual Bill In receives the goods) and writes no ItemStatusHistory row. Each
// line is priced at COST (vendor-facing), not wholesale. The schema requires an
// inventory item per line, so a PO is raised against existing stock; an item with
// no vendor or THIS vendor is allowed, one belonging to a different vendor is not.
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
          // lineStatus is inert on a PO line (memo-line resolution is a Memo Out
          // concept and can't even represent RESERVED) — the neutral IN_STOCK.
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

// Create an INBOUND document (Bill In / Memo In) that RECEIVES new inventory from
// a vendor (Jennifer 2026-07-22 — the inbound doc IS the upload vehicle). Unlike
// outbound create (which draws down existing stock), this CREATES each item
// (-> IN_STOCK) and links it to the doc. Design decisions:
//   • BILL_IN = purchase/owned, MEMO_IN = consignment (vendor keeps ownership) —
//     the distinction is the doc TYPE, not a separate item field (payments +
//     ownership live in QuickBooks, not the portal).
//   • The doc carries the vendor's OWN number in externalReference; no internal
//     documentNumber is minted (inbound never draws a sequence).
//   • Every item inherits the doc's vendorId; brandOwner is not set here. Lines
//     are priced at COST (the vendor-facing basis), lineStatus IN_STOCK.
//   • Each new item gets a null -> IN_STOCK ItemStatusHistory row pointing at this
//     doc: receiving here IS "through a document" (contrast the manual inventory
//     create, which writes none). dueDate = the caller's issueDate (today when
//     omitted) plus the vendor's terms, so a back-dated receipt is due on time.
// Transactional with a batch SKU mint + whole-tx retry on a sku race. NOTE: a very
// large bulk migration (case A) may need chunking/timeout tuning; the ongoing
// per-document receive (case B) is well within one tx.
export async function createInboundDocument(
  input: ImsCreateInboundDocument,
  createdById: string
): Promise<CreateDocumentResult> {
  const isBrandIn = input.type === "BRAND_INVENTORY_IN";
  const issueDate = issuedAt(input.issueDate);

  // Resolve the party + the owner each received item is tagged with. A Bill In /
  // Memo In is addressed to a vendor and items inherit that vendorId; a Brand In
  // is addressed to the brand owner (a Company) and items inherit brandOwnerId —
  // it's the designer's stock we hold, so it carries no vendor and no due date.
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

  // SKU strategy: honor a caller-supplied SKU (bulk-CSV migration preserving the
  // template's "RADIIA SKU" column); auto-mint for any item without one. Validate
  // up front so a bad upload fails cleanly instead of half-importing.
  const providedSkus = input.items.map((it) => (it.sku ?? "").trim() || null);
  const providedList = providedSkus.filter((s): s is string => s !== null);

  // Two rows in ONE upload claiming the same SKU stays an error. Buying more of
  // a SKU is a real event (handled below); the same SKU twice in one sheet is a
  // copy-paste, and folding them silently would hide it. Splitting the file into
  // two receipts is the honest way to record two purchases.
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

  // A SKU already in stock is a RESTOCK, not a collision (Jennifer 2026-08-03):
  // the carats arriving are added to the balance instead of minting a second row
  // under the same number. Every plan is resolved BEFORE the transaction so an
  // impossible merge — a single stone, a type mismatch — rejects the whole
  // document without a partial write, exactly as the SKU guard used to.
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
          // Mint only for items that are neither restocks nor already carrying a
          // preserved SKU, then weave the three back into item order.
          const needsMint = providedSkus.filter((s, i) => s === null && !restockPlans.has(i)).length;
          const minted = await mintSkuBatch(tx, needsMint);
          let mi = 0;
          const skus = providedSkus.map((s, i) => (restockPlans.has(i) ? s! : (s ?? minted[mi++])));

          const lines: Array<({ inventoryItemId: string } & ReturnType<typeof costSnapshot>) | null> =
            new Array(input.items.length).fill(null);
          const createdItemIds: string[] = [];
          const restoredItemIds: Array<{ id: string; from: string }> = [];

          // A bulk migration (case A, hundreds of rows) can't afford one
          // create + one history insert per item — that's 300+ serialized
          // round-trips inside a single tx and risks the transaction timeout.
          // Every plain-create item is instead assembled locally, then written
          // in a handful of createMany batches: the InventoryItem rows first
          // (so the DB mints their ids), then the matching detail rows keyed
          // off the sku (unique per item within this upload — the dupe guard
          // above already proved that).
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

            // Restock: add to the item already there. The line records what
            // ARRIVED (not the new total) — the vendor billed us for these
            // carats, not for the lot we already owned.
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
              // A lot that had sold out is back on the shelf.
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

          // A Brand In is a doc RADIIA originates (no vendor bill), so it mints its
          // own BIN-#### number like an outbound doc. A Bill In / Memo In instead
          // records the vendor's own number in externalReference and mints none.
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

          // Provenance: each item was brought into stock THROUGH this document.
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

          // A restock only earns an audit row when it actually moved the status
          // (a sold-out lot coming back). Topping up a lot that was already in
          // stock changes no status, and the document line is the record of it.
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
      if (isUniqueViolation(e) && attempt < 2) continue; // sku raced — re-mint whole batch
      throw e;
    }
  }
  return { ok: false, error: "Could not allocate unique SKUs — please retry" };
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
        where: { id: line.inventoryItemId },
        include: { stone: true }
      });

      // A parcel's carats came off the balance when the memo was written, so a
      // return puts exactly that slice back — the REVERSE half of the draw pair.
      if (item.itemSubtype === "PARCEL" && item.stone) {
        const restored = reverseDraw(item.stone, num(line.caratWeight), line.quantity);
        await tx.stoneDetail.update({
          where: { inventoryItemId: item.id },
          data: { remainingCt: restored.remainingCt, remainingQty: restored.remainingQty }
        });
      }

      // A partially-drawn parcel never left IN_STOCK, so there is no transition
      // to record. Writing one anyway would put IN_STOCK -> IN_STOCK rows in the
      // audit trail, which is the history a stone's page is read from.
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

    // Auto-close the memo iff nothing is still out (partial return keeps it OPEN).
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

// ── Email / QuickBooks stamps (admin sendEmail / _runSync) ───────────────────
// Both are batch actions over a set of selected docs. Each stamps a single
// timestamp column and returns the updated docs; neither is transactional
// (one updateMany is atomic) and neither needs an actor (Document records the
// timestamps, not who did it).

// Only money docs sync to QuickBooks (admin qboRow gate). BILL_IN is inbound and
// not creatable yet, but the rule is correct for when it is.
const QBO_SYNCABLE_TYPES: PrismaDocumentType[] = ["INVOICE", "BILL_IN"];

// Load the requested docs (deduped) and refuse the batch if any id is unknown —
// a partial stamp would silently drop docs the caller thinks it acted on.
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

// Stamp emailedAt = now on each doc (admin sendEmail). Any doc type can be
// emailed; status is untouched.
export async function emailDocuments(ids: string[]): Promise<StampDocumentsResult> {
  const loaded = await requireDocuments(ids);
  if (!loaded.ok) return { ok: false, error: loaded.error };

  await prisma.document.updateMany({
    where: { id: { in: loaded.unique } },
    data: { emailedAt: new Date() }
  });
  return { ok: true, documents: await reloadDocs(loaded.unique) };
}

// Stamp quickbooksSyncedAt = now on each money doc (admin _runSync). The
// timestamp IS the "synced" signal (null = unsynced). Status is intentionally
// left unchanged: the admin mock closes INVOICE/BILL_IN on sync, but the schema
// separates the synced-timestamp from lifecycle status and even carries a
// distinct EXPORTED status — whether a sync should also close/export the doc is
// a lifecycle-rulebook call flagged for Jennifer, not something to bake here.
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
