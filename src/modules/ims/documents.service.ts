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

import { sendDocumentEmail } from "@/integrations/email";

import { buildDocumentPdfs } from "./document-pdf";
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

/**
 * Rows per bulk INSERT. A single createMany of several hundred rows becomes one
 * enormous statement; over a pooled connection that is where large inbound
 * imports were stalling. Chunking keeps every statement small and bounded.
 */
const INSERT_CHUNK = 100;

async function createManyChunked<T>(
  rows: T[],
  insert: (batch: T[]) => Promise<unknown>
): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await insert(rows.slice(i, i + INSERT_CHUNK));
  }
}

/**
 * The same bounded-statement rule for an id list: `WHERE id IN (...)` of several
 * hundred is the same oversized statement a bulk INSERT was.
 */
async function idsChunked(
  ids: string[],
  run: (batch: string[]) => Promise<unknown>
): Promise<void> {
  for (let i = 0; i < ids.length; i += INSERT_CHUNK) {
    await run(ids.slice(i, i + INSERT_CHUNK));
  }
}

/**
 * An inbound document can carry hundreds of items, and each one fans out into
 * item / detail / line / audit rows. 30s was not a real budget for that on a
 * remote database — a 374-item import legitimately needs longer.
 */
const INBOUND_TX_TIMEOUT_MS = Number(process.env.IMS_INBOUND_TX_TIMEOUT_MS ?? 120_000);

/**
 * An outbound document has the same problem going the other way: memoing a
 * brand's whole open stock out to one store is 300+ lines, and each one costs a
 * balance write, a memo lookup, a status update and an audit row. 320 lines
 * runs in ~1.7s against a local database; every one of those round trips is
 * slower against a remote one, so the 5s default is not a real budget either.
 */
const OUTBOUND_TX_TIMEOUT_MS = Number(process.env.IMS_OUTBOUND_TX_TIMEOUT_MS ?? 120_000);

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

async function recomputeMemoClose(
  tx: Prisma.TransactionClient,
  memoId: string,
  openStatus: "ON_MEMO" | "IN_STOCK" = "ON_MEMO"
): Promise<void> {
  const lines = await tx.documentLineItem.findMany({
    where: { documentId: memoId },
    select: { lineStatus: true }
  });
  const stillOut = lines.filter((l) => l.lineStatus === openStatus).length;
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

  if (type === "BRAND_INVENTORY_OUT") {
    const notOwned = items.filter((i) => i.brandOwnerId !== input.clientId);
    if (notOwned.length > 0) {
      const detail = notOwned.map((i) => i.sku).join(", ");
      return {
        ok: false,
        error: `Cannot return to this brand: item(s) not owned by them: ${detail}`
      };
    }
  }

  /**
   * Lines whose stock is already out on a memo and so must not be drawn from
   * the safe a second time.
   *
   * An INVOICE looks only at memos to the SAME client: that is the settle case,
   * where the client is buying what they are already holding. A slice out to
   * someone else is not theirs to settle, so it stays a fresh draw against what
   * is left — the documented "a client holding 4 ct can still buy 2 more".
   *
   * A MEMO_OUT is the opposite: whoever holds it, the piece is moving to a new
   * memo, so the lookup is unscoped and only reaches items that are ON_MEMO —
   * an item still in the safe is an ordinary draw.
   */
  const memoLineByItem = new Map<string, { id: string; caratWeight: number | null; quantity: number | null }>();
  const transferring = type === "MEMO_OUT";

  /** Divisible lots keep a balance, so they are the ones a settle protects from
   *  being drawn a second time. An atomic piece has no balance to double-spend. */
  const divisibleById = new Map(
    items.map((i) => [i.id, i.itemSubtype === "PARCEL" || i.itemType === "JEWELRY"])
  );

  const collectMemoLines = async (
    scopeIds: string[],
    clientScoped: boolean,
    tooMany: (sku: string) => string
  ): Promise<{ ok: false; error: string } | null> => {
    if (scopeIds.length === 0) return null;
    const openMemoLines = await prisma.documentLineItem.findMany({
      where: {
        inventoryItemId: { in: scopeIds },
        lineStatus: "ON_MEMO",
        document: clientScoped
          ? { type: "MEMO_OUT", clientId: input.clientId }
          : { type: "MEMO_OUT" }
      },
      select: { id: true, inventoryItemId: true, caratWeight: true, quantity: true }
    });
    for (const ml of openMemoLines) {
      const item = items.find((i) => i.id === ml.inventoryItemId);
      if (!item || !divisibleById.get(item.id)) continue;
      if (memoLineByItem.has(ml.inventoryItemId)) {
        return { ok: false, error: tooMany(item.sku) };
      }
      memoLineByItem.set(ml.inventoryItemId, {
        id: ml.id,
        caratWeight: num(ml.caratWeight),
        quantity: ml.quantity
      });
    }
    return null;
  };

  if (type === "INVOICE") {
    // The client is buying what they are already holding. Scoped to them on
    // purpose: a slice out to somebody else is not theirs to settle, so it stays
    // a fresh draw against what is left — the documented "a client holding 4 ct
    // can still buy 2 more".
    const scoped = await collectMemoLines(
      ids,
      true,
      (sku) =>
        `${sku} is out on more than one open memo to this client — record a return on one of them before invoicing`
    );
    if (scoped) return scoped;
  }

  // Whatever is left that is ON_MEMO is out with somebody else, and for a lot
  // that means the safe is empty — ON_MEMO is only reached once the last piece
  // leaves. So there is nothing to draw from and only one thing the document can
  // mean: the goods come back off that memo. An invoice sells them to the new
  // client, a memo hands them on. Either way the old line is resolved below.
  const strandedOnMemo = items
    .filter((i) => i.status === "ON_MEMO" && !memoLineByItem.has(i.id))
    .map((i) => i.id);
  const unscoped = await collectMemoLines(strandedOnMemo, false, (sku) =>
    transferring
      ? `${sku} is out on more than one open memo — record a return on one of them before moving it`
      : `${sku} is out on more than one open memo — record a return on one of them before invoicing`
  );
  if (unscoped) return unscoped;

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

  const t0 = Date.now();
  const mark = (label: string): void => {
    console.log(
      `[createOutboundDocument] ${label} @ ${Date.now() - t0}ms (type=${type}, lines=${snapshots.length})`
    );
  };

  let docId: string;
  try {
    docId = await prisma.$transaction(
      async (tx) => {
        mark("tx started");
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
            status: type === "BRAND_INVENTORY_OUT" ? "CLOSED" : "OPEN",
            clientId: input.clientId,
            issueDate,
            dueDate,
            discountAmount: input.discountAmount ?? null,
            notes: input.notes ?? null,
            createdById
          }
        });
        mark("document row created");

        // A nested `create` costs one round trip per line, so a 374-line memo
        // spent 374 of them before any stock had moved. Bulk-insert instead.
        await createManyChunked(
          snapshots.map((s) => ({
            documentId: doc.id,
            inventoryItemId: s.itemId,
            lineStatus: newLineStatus,
            quantity: s.quantity,
            caratWeight: s.caratWeight,
            unitPrice: s.unitPrice,
            totalPrice: s.totalPrice,
            clientReference: s.clientReference
          })),
          (b) => tx.documentLineItem.createMany({ data: b })
        );
        mark("line items inserted");

        // A balance write carries a per-item number, so these group by the value
        // written rather than collapsing to a single statement. Sending whole
        // lots — the bulk case — puts every row on the same balance, so in
        // practice it becomes one.
        const parcelBalances = new Map<string, { ct: number; qty: number | null; ids: string[] }>();
        const jewelryBalances = new Map<number, string[]>();
        for (const s of snapshots) {
          const { draw } = s;
          if (draw.lot === "PARCEL" && draw.remainingAfterCt !== null) {
            const key = `${draw.remainingAfterCt}|${draw.remainingAfterQty}`;
            const bucket = parcelBalances.get(key);
            if (bucket) bucket.ids.push(s.itemId);
            else {
              parcelBalances.set(key, {
                ct: draw.remainingAfterCt,
                qty: draw.remainingAfterQty,
                ids: [s.itemId]
              });
            }
          } else if (draw.lot === "JEWELRY" && draw.remainingAfterQty !== null) {
            const bucket = jewelryBalances.get(draw.remainingAfterQty);
            if (bucket) bucket.push(s.itemId);
            else jewelryBalances.set(draw.remainingAfterQty, [s.itemId]);
          }
        }
        for (const b of parcelBalances.values()) {
          await idsChunked(b.ids, (batch) =>
            tx.stoneDetail.updateMany({
              where: { inventoryItemId: { in: batch } },
              data: { remainingCt: b.ct, remainingQty: b.qty }
            })
          );
        }
        for (const [remainingQty, ids] of jewelryBalances) {
          await idsChunked(ids, (batch) =>
            tx.jewelryDetail.updateMany({
              where: { inventoryItemId: { in: batch } },
              data: { remainingQty }
            })
          );
        }
        mark("balances written");

        // A partial draw leaves the lot in stock, so it gets no status change
        // and no audit row.
        const advancing = snapshots.filter((s) => !(s.draw.isPartial && !s.draw.emptied));

        // A settling line only moves the item if it is not still out on some
        // other document — one lookup for all of them, not one each. This
        // document's own lines are excluded: a MEMO_OUT writes ON_MEMO lines,
        // so the line just created would otherwise read as somebody else's
        // claim and hold the item back from its own document.
        const settling = advancing.filter((s) => s.settlesMemoLineId);
        const heldBack = new Set<string>();
        if (settling.length > 0) {
          const stillOut = await tx.documentLineItem.findMany({
            where: {
              inventoryItemId: { in: settling.map((s) => s.itemId) },
              lineStatus: "ON_MEMO",
              documentId: { not: doc.id }
            },
            select: { id: true, inventoryItemId: true }
          });
          const linesByItem = new Map<string, string[]>();
          for (const l of stillOut) {
            const list = linesByItem.get(l.inventoryItemId);
            if (list) list.push(l.id);
            else linesByItem.set(l.inventoryItemId, [l.id]);
          }
          for (const s of settling) {
            const others = (linesByItem.get(s.itemId) ?? []).filter((id) => id !== s.settlesMemoLineId);
            if (others.length > 0) heldBack.add(s.itemId);
          }
        }

        const moving = advancing.filter((s) => !heldBack.has(s.itemId));
        if (moving.length > 0) {
          await idsChunked(
            moving.map((s) => s.itemId),
            (batch) =>
              tx.inventoryItem.updateMany({
                where: { id: { in: batch } },
                data: { status: newItemStatus, visibleOnPortal: false }
              })
          );
          // A transfer moves ON_MEMO to ON_MEMO, so the status column alone
          // would say nothing happened. The note is the only thing on the
          // item's history that records the hand-off.
          await createManyChunked(
            moving.map((s) => ({
              inventoryItemId: s.itemId,
              previousStatus: s.currentStatus,
              newStatus: newItemStatus,
              documentId: doc.id,
              changedById: createdById,
              note:
                transferring && s.currentStatus === "ON_MEMO"
                  ? `Moved from an open memo onto ${documentNumber}`
                  : null
            })),
            (b) => tx.itemStatusHistory.createMany({ data: b })
          );
        }
        mark("statuses advanced");

        // Skipping the Return Memo Out is the point of the transfer, so the new
        // memo has to do the return's work: the old line is resolved here, or
        // both memos would go on claiming the same piece.
        if (transferring) {
          const movedFromMemo = snapshots.filter((s) => s.currentStatus === "ON_MEMO");
          if (movedFromMemo.length > 0) {
            const priorLines = await tx.documentLineItem.findMany({
              where: {
                inventoryItemId: { in: movedFromMemo.map((s) => s.itemId) },
                lineStatus: "ON_MEMO",
                documentId: { not: doc.id },
                document: { type: "MEMO_OUT" }
              },
              select: { id: true, documentId: true }
            });
            const affectedMemoIds = new Set(priorLines.map((l) => l.documentId));
            await idsChunked(
              priorLines.map((l) => l.id),
              (batch) =>
                tx.documentLineItem.updateMany({
                  where: { id: { in: batch } },
                  data: { lineStatus: "RETURNED", resolvedByDocumentId: doc.id }
                })
            );
            for (const memoId of affectedMemoIds) {
              await recomputeMemoClose(tx, memoId);
            }
            mark("prior memo lines released");
          }
        }

        if (type === "INVOICE") {
          const affectedMemoIds = new Set<string>();

          const settleIds = snapshots
            .map((s) => s.settlesMemoLineId)
            .filter((id): id is string => id !== null);
          if (settleIds.length > 0) {
            const settled = await tx.documentLineItem.findMany({
              where: { id: { in: settleIds } },
              select: { documentId: true }
            });
            for (const l of settled) affectedMemoIds.add(l.documentId);
            await idsChunked(settleIds, (batch) =>
              tx.documentLineItem.updateMany({
                where: { id: { in: batch } },
                data: { lineStatus: "SOLD", resolvedByDocumentId: doc.id }
              })
            );
          }

          // Runs after the settle above, so lines already marked SOLD there no
          // longer match — the same order the per-item loop relied on.
          const soldFromMemo = snapshots.filter(
            (s) => !s.settlesMemoLineId && s.currentStatus === "ON_MEMO"
          );
          if (soldFromMemo.length > 0) {
            const memoLines = await tx.documentLineItem.findMany({
              where: {
                inventoryItemId: { in: soldFromMemo.map((s) => s.itemId) },
                lineStatus: "ON_MEMO",
                document: { type: "MEMO_OUT" }
              },
              select: { id: true, documentId: true }
            });
            for (const ml of memoLines) affectedMemoIds.add(ml.documentId);
            await idsChunked(
              memoLines.map((l) => l.id),
              (batch) =>
                tx.documentLineItem.updateMany({
                  where: { id: { in: batch } },
                  data: { lineStatus: "SOLD", resolvedByDocumentId: doc.id }
                })
            );
          }
          for (const memoId of affectedMemoIds) {
            await recomputeMemoClose(tx, memoId);
          }
          mark("memo lines settled");

          const affectedMemoInIds = new Set<string>();
          const eligible = snapshots.filter((s) => !(s.draw.isPartial && !s.draw.emptied));
          if (eligible.length > 0) {
            const memoInLines = await tx.documentLineItem.findMany({
              where: {
                inventoryItemId: { in: eligible.map((s) => s.itemId) },
                lineStatus: "IN_STOCK",
                document: { type: "MEMO_IN", status: "OPEN" }
              },
              select: { id: true, documentId: true, inventoryItemId: true }
            });
            // One line per item, as the per-item findFirst took.
            const firstByItem = new Map<string, { id: string; documentId: string }>();
            for (const l of memoInLines) {
              if (!firstByItem.has(l.inventoryItemId)) firstByItem.set(l.inventoryItemId, l);
            }
            for (const l of firstByItem.values()) affectedMemoInIds.add(l.documentId);
            await idsChunked(
              [...firstByItem.values()].map((l) => l.id),
              (batch) =>
                tx.documentLineItem.updateMany({
                  where: { id: { in: batch } },
                  data: { lineStatus: "SOLD", resolvedByDocumentId: doc.id }
                })
            );
          }
          for (const memoInId of affectedMemoInIds) {
            await recomputeMemoClose(tx, memoInId, "IN_STOCK");
          }
          mark("memo-in lines settled");
        }

        mark("tx callback returning");
        return doc.id;
      },
      { timeout: OUTBOUND_TX_TIMEOUT_MS, maxWait: 15_000 }
    );
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2028") {
      // Ran out of transaction budget. Nothing was written — the whole thing
      // rolls back — so say that plainly instead of a bare "Internal error".
      return {
        ok: false,
        error: `This ${DOC_LABEL[type]} (${snapshots.length} lines) took too long to save and was rolled back — nothing was created. Try splitting it into smaller documents.`
      };
    }
    throw e;
  }

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
  BRAND_INVENTORY_OUT:
    "A Brand Out is the record of stones going back to the brand — it cannot be voided. Correct it by recording the movement again on a new document."
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

  // Undoing a 374-line memo is the same scale as making one, so it reads the
  // audit trail once up front and writes in batches rather than per line.
  const historyRows = await prisma.itemStatusHistory.findMany({
    where: { documentId: doc.id, inventoryItemId: { in: doc.lineItems.map((l) => l.inventoryItemId) } },
    orderBy: { changedAt: "desc" },
    select: { inventoryItemId: true, previousStatus: true, newStatus: true }
  });
  const latestByItem = new Map<string, (typeof historyRows)[number]>();
  for (const h of historyRows) {
    if (!latestByItem.has(h.inventoryItemId)) latestByItem.set(h.inventoryItemId, h);
  }

  try {
    await prisma.$transaction(
      async (tx) => {
        const parcelBalances = new Map<string, { ct: number | null; qty: number | null; ids: string[] }>();
        const jewelryBalances = new Map<number, string[]>();
        // Grouped by the status being restored — a memo put everything in the
        // same place, so in practice each of these is one statement.
        const statusRestores = new Map<string, string[]>();
        const lineRestores = new Map<string, string[]>();
        const historyWrites: Prisma.ItemStatusHistoryCreateManyInput[] = [];

        for (const line of doc.lineItems) {
          const item = line.inventoryItem;
          const stone = item.stone;
          const isParcelLine = drewStock && item.itemSubtype === "PARCEL" && stone !== null;

          if (isParcelLine && stone) {
            const restored = reverseDraw(stone, num(line.caratWeight), line.quantity);
            const key = `${restored.remainingCt}|${restored.remainingQty}`;
            const bucket = parcelBalances.get(key);
            if (bucket) bucket.ids.push(item.id);
            else {
              parcelBalances.set(key, {
                ct: restored.remainingCt,
                qty: restored.remainingQty,
                ids: [item.id]
              });
            }
          } else if (drewStock && item.itemType === "JEWELRY" && item.jewelry) {
            const restored = reverseJewelryDraw(item.jewelry, line.quantity);
            const bucket = jewelryBalances.get(restored);
            if (bucket) bucket.push(item.id);
            else jewelryBalances.set(restored, [item.id]);
          }

          const history = latestByItem.get(item.id);
          const priorStatus = history?.previousStatus;
          if (!priorStatus) continue;

          const byStatus = statusRestores.get(priorStatus);
          if (byStatus) byStatus.push(item.id);
          else statusRestores.set(priorStatus, [item.id]);

          const lineStatus = priorStatus === "ON_MEMO" ? "ON_MEMO" : "IN_STOCK";
          const byLine = lineRestores.get(lineStatus);
          if (byLine) byLine.push(line.id);
          else lineRestores.set(lineStatus, [line.id]);

          historyWrites.push({
            inventoryItemId: item.id,
            previousStatus: history!.newStatus,
            newStatus: priorStatus,
            documentId: doc.id,
            changedById: actorId
          });
        }

        for (const b of parcelBalances.values()) {
          await idsChunked(b.ids, (batch) =>
            tx.stoneDetail.updateMany({
              where: { inventoryItemId: { in: batch } },
              data: { remainingCt: b.ct, remainingQty: b.qty }
            })
          );
        }
        for (const [remainingQty, ids] of jewelryBalances) {
          await idsChunked(ids, (batch) =>
            tx.jewelryDetail.updateMany({
              where: { inventoryItemId: { in: batch } },
              data: { remainingQty }
            })
          );
        }
        for (const [status, ids] of statusRestores) {
          await idsChunked(ids, (batch) =>
            tx.inventoryItem.updateMany({
              where: { id: { in: batch } },
              data: { status: status as ItemWithDetails["status"] }
            })
          );
        }
        for (const [lineStatus, ids] of lineRestores) {
          await idsChunked(ids, (batch) =>
            tx.documentLineItem.updateMany({
              where: { id: { in: batch } },
              data: { lineStatus: lineStatus as "ON_MEMO" | "IN_STOCK" }
            })
          );
        }
        await createManyChunked(historyWrites, (b) => tx.itemStatusHistory.createMany({ data: b }));

        await tx.document.update({
          where: { id: doc.id },
          data: { status: "VOID", closeReason: null }
        });
      },
      { timeout: OUTBOUND_TX_TIMEOUT_MS, maxWait: 15_000 }
    );
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2028") {
      return {
        ok: false,
        error: `Voiding this ${label} (${doc.lineItems.length} lines) took too long and was rolled back — nothing was changed.`
      };
    }
    throw e;
  }

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

  const explicitSkus = input.items.map((it) => (it.sku ?? "").trim() || null);
  const explicitList = explicitSkus.filter((s): s is string => s !== null);

  if (new Set(explicitList).size !== explicitList.length) {
    const seen = new Set<string>();
    const dupes = Array.from(
      new Set(explicitList.filter((s) => (seen.has(s) ? true : (seen.add(s), false))))
    );
    return {
      ok: false,
      error: `The upload lists the same RADIIA SKU more than once: ${dupes.join(", ")}. Combine those rows, or receive them on separate documents.`
    };
  }

  const existingBySku = new Map<string, ExistingItem>();
  if (explicitList.length > 0) {
    const rows = await prisma.inventoryItem.findMany({
      where: { sku: { in: explicitList } },
      select: RESTOCK_ITEM_SELECT
    });
    for (const row of rows) existingBySku.set(row.sku, row);
  }

  const restockPlans = new Map<number, RestockPlan>();
  for (let i = 0; i < input.items.length; i++) {
    const sku = explicitSkus[i];
    const existing = sku === null ? undefined : existingBySku.get(sku);
    if (!existing) continue;
    const resolved = resolveRestock(existing, input.items[i]);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    restockPlans.set(i, resolved.plan);
  }

  // A row that names no RADIIA SKU takes the vendor/brand's own number, so the
  // memo shows the client the SKU the brand knows the piece by. Naming an
  // existing SKU outright is the one thing that tops up a lot (above); a copy
  // never does — where the number is already taken, by stock on the books or by
  // an earlier row of this same upload, the row gets a minted RAD-#### instead
  // of merging into someone else's item.
  const claimed = new Set(explicitList);
  const copyCandidates = input.items.map((it, i) =>
    explicitSkus[i] !== null ? null : (it.vendorSku ?? "").trim() || null
  );
  const candidateList = [...new Set(copyCandidates.filter((s): s is string => s !== null))];
  if (candidateList.length > 0) {
    const taken = await prisma.inventoryItem.findMany({
      where: { sku: { in: candidateList } },
      select: { sku: true }
    });
    for (const t of taken) claimed.add(t.sku);
  }
  const copiedSkus = copyCandidates.map((c) => {
    if (c === null || claimed.has(c)) return null;
    claimed.add(c);
    return c;
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const t0 = Date.now();
      const mark = (label: string): void => {
        console.log(
          `[createInboundDocument] ${label} @ ${Date.now() - t0}ms (attempt ${attempt}, items=${input.items.length})`
        );
      };
      const docId = await prisma.$transaction(
        async (tx) => {
          mark("tx started");
          // Reaching a retry means some SKU collided anyway (a concurrent
          // upload claiming the same vendor number). Only a minted one is
          // guaranteed free, so later attempts stop copying.
          const copies = attempt === 0 ? copiedSkus : copiedSkus.map(() => null);
          const needsMint = explicitSkus.filter(
            (s, i) => s === null && copies[i] === null && !restockPlans.has(i)
          ).length;
          const minted = await mintSkuBatch(tx, needsMint);
          mark("skus minted");
          let mi = 0;
          const skus = explicitSkus.map((s, i) =>
            restockPlans.has(i) ? s! : (s ?? copies[i] ?? minted[mi++])
          );

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
          mark("restock plans applied");

          if (pending.length) {
            const createdCore: Array<{ id: string; sku: string }> = [];
            await createManyChunked(
              pending.map((p) => p.core),
              async (batch) => {
                createdCore.push(
                  ...(await tx.inventoryItem.createManyAndReturn({
                    data: batch,
                    select: { id: true, sku: true }
                  }))
                );
              }
            );
            mark("core inventory items inserted");
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
            await createManyChunked(stoneRows, (b) => tx.stoneDetail.createMany({ data: b as any }));
            await createManyChunked(jewelryRows, (b) => tx.jewelryDetail.createMany({ data: b as any }));
            await createManyChunked(materialRows, (b) =>
              tx.otherMaterialDetail.createMany({ data: b as any })
            );
            mark("detail rows inserted");
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
          mark("document number minted");

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
              createdById
            }
          });
          mark("document row created");

          await createManyChunked(
            (lines as Array<{ inventoryItemId: string } & ReturnType<typeof costSnapshot>>).map(
              (l) => ({
                documentId: doc.id,
                inventoryItemId: l.inventoryItemId,
                lineStatus: "IN_STOCK" as const,
                quantity: l.quantity,
                caratWeight: l.caratWeight,
                unitPrice: l.unitPrice,
                totalPrice: l.totalPrice
              })
            ),
            (b) => tx.documentLineItem.createMany({ data: b })
          );
          mark("line items inserted");

          if (createdItemIds.length) {
            await createManyChunked(
              createdItemIds.map((inventoryItemId) => ({
                inventoryItemId,
                previousStatus: null,
                newStatus: "IN_STOCK" as const,
                documentId: doc.id,
                changedById: createdById
              })),
              (b) => tx.itemStatusHistory.createMany({ data: b })
            );
            mark("created-item status history inserted");
          }

          if (restoredItemIds.length) {
            await createManyChunked(
              restoredItemIds.map(({ id, from }) => ({
                inventoryItemId: id,
                previousStatus: from as ItemWithDetails["status"],
                newStatus: "IN_STOCK" as const,
                documentId: doc.id,
                changedById: createdById
              })),
              (b) => tx.itemStatusHistory.createMany({ data: b })
            );
            mark("restored-item status history inserted");
          }

          mark("tx callback returning");
          return doc.id;
        },
        { timeout: INBOUND_TX_TIMEOUT_MS, maxWait: 15_000 }
      );

      const created = await prisma.document.findUniqueOrThrow({
        where: { id: docId },
        include: IMS_DOC_INCLUDE
      });
      return { ok: true, document: prismaDocToDto(created) };
    } catch (e) {
      if (isUniqueViolation(e) && attempt < 2) continue;
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2028") {
        // Ran out of transaction budget. Nothing was written — the whole thing
        // rolls back — so say that plainly instead of a bare "Internal error".
        return {
          ok: false,
          error: `This upload (${input.items.length} items) took too long to save and was rolled back — nothing was created. Try splitting it into smaller uploads.`
        };
      }
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

  // Returning the whole of a 300-line memo is the other half of sending it, so
  // it gets the same treatment: read the stock once up front instead of once per
  // line, and write in batches.
  const returningItems = await prisma.inventoryItem.findMany({
    where: { id: { in: targetLines.map((l) => l.inventoryItemId) } },
    include: { stone: true, jewelry: true }
  });
  const returningById = new Map(returningItems.map((i) => [i.id, i]));
  const missing = targetLines.filter((l) => !returningById.has(l.inventoryItemId));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Inventory item(s) not found: ${missing.map((l) => l.inventoryItemId).join(", ")}`
    };
  }

  let returnDocId: string;
  try {
    returnDocId = await prisma.$transaction(
      async (tx) => {
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
            createdById: changedById
          }
        });

        await createManyChunked(
          targetLines.map((l) => ({
            documentId: returnDoc.id,
            inventoryItemId: l.inventoryItemId,
            lineStatus: "RETURNED" as const
          })),
          (b) => tx.documentLineItem.createMany({ data: b })
        );

        await idsChunked(
          targetLines.map((l) => l.id),
          (batch) =>
            tx.documentLineItem.updateMany({
              where: { id: { in: batch } },
              data: { lineStatus: "RETURNED", resolvedByDocumentId: returnDoc.id }
            })
        );

        // Each restored balance is that line's own number, so these group by the
        // value written rather than collapsing to one statement.
        const parcelBalances = new Map<string, { ct: number | null; qty: number | null; ids: string[] }>();
        const jewelryBalances = new Map<number, string[]>();
        const backInStock: Array<{ id: string; from: ItemWithDetails["status"] }> = [];
        for (const line of targetLines) {
          const item = returningById.get(line.inventoryItemId)!;

          if (item.itemSubtype === "PARCEL" && item.stone) {
            const restored = reverseDraw(item.stone, num(line.caratWeight), line.quantity);
            const key = `${restored.remainingCt}|${restored.remainingQty}`;
            const bucket = parcelBalances.get(key);
            if (bucket) bucket.ids.push(item.id);
            else {
              parcelBalances.set(key, {
                ct: restored.remainingCt,
                qty: restored.remainingQty,
                ids: [item.id]
              });
            }
          } else if (item.itemType === "JEWELRY" && item.jewelry) {
            const restored = reverseJewelryDraw(item.jewelry, line.quantity);
            const bucket = jewelryBalances.get(restored);
            if (bucket) bucket.push(item.id);
            else jewelryBalances.set(restored, [item.id]);
          }

          if (item.status !== "IN_STOCK") backInStock.push({ id: item.id, from: item.status });
        }

        for (const b of parcelBalances.values()) {
          await idsChunked(b.ids, (batch) =>
            tx.stoneDetail.updateMany({
              where: { inventoryItemId: { in: batch } },
              data: { remainingCt: b.ct, remainingQty: b.qty }
            })
          );
        }
        for (const [remainingQty, ids] of jewelryBalances) {
          await idsChunked(ids, (batch) =>
            tx.jewelryDetail.updateMany({
              where: { inventoryItemId: { in: batch } },
              data: { remainingQty }
            })
          );
        }

        if (backInStock.length > 0) {
          await idsChunked(
            backInStock.map((b) => b.id),
            (batch) =>
              tx.inventoryItem.updateMany({
                where: { id: { in: batch } },
                data: { status: "IN_STOCK" }
              })
          );
          await createManyChunked(
            backInStock.map(({ id, from }) => ({
              inventoryItemId: id,
              previousStatus: from,
              newStatus: "IN_STOCK" as const,
              documentId: returnDoc.id,
              changedById
            })),
            (b) => tx.itemStatusHistory.createMany({ data: b })
          );
        }

        await recomputeMemoClose(tx, memo.id);

        return returnDoc.id;
      },
      { timeout: OUTBOUND_TX_TIMEOUT_MS, maxWait: 15_000 }
    );
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2028") {
      return {
        ok: false,
        error: `This return (${targetLines.length} lines) took too long to save and was rolled back — nothing was changed. Try returning fewer lines at a time.`
      };
    }
    throw e;
  }

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

export async function recordVendorReturn(
  memoId: string,
  input: ImsRecordReturn,
  actorId: string
): Promise<RecordReturnResult> {
  const memo = await prisma.document.findUnique({
    where: { id: memoId },
    include: { lineItems: true }
  });
  if (!memo) return { ok: false, error: "Memo not found" };
  if (memo.type !== "MEMO_IN") return { ok: false, error: "Document is not a Memo In" };

  const inStockLines = memo.lineItems.filter((l) => l.lineStatus === "IN_STOCK");
  if (inStockLines.length === 0) {
    return { ok: false, error: "This Memo In has nothing still available to return" };
  }

  const itemRows = await prisma.inventoryItem.findMany({
    where: { id: { in: inStockLines.map((l) => l.inventoryItemId) } },
    include: { stone: true, jewelry: true, material: true }
  });
  const itemById = new Map(itemRows.map((i) => [i.id, i]));

  const availableLines = inStockLines.filter(
    (l) => itemById.get(l.inventoryItemId)?.status === "IN_STOCK"
  );

  let targetLines = availableLines;
  if (input.inventoryItemIds && input.inventoryItemIds.length > 0) {
    const wanted = new Set(input.inventoryItemIds);
    targetLines = availableLines.filter((l) => wanted.has(l.inventoryItemId));
    const returnable = new Set(availableLines.map((l) => l.inventoryItemId));
    const bad = input.inventoryItemIds.filter((id) => !returnable.has(id));
    if (bad.length > 0) {
      return {
        ok: false,
        error: `Not currently available to return on this Memo In: ${bad.join(", ")}`
      };
    }
  }
  if (targetLines.length === 0) return { ok: false, error: "No matching items to return" };

  const snapshots: Array<{
    lineId: string;
    itemId: string;
    currentStatus: ItemWithDetails["status"];
    draw: ResolvedDraw;
  }> = [];
  for (const line of targetLines) {
    const item = itemById.get(line.inventoryItemId)!;
    const jewelryLot = item.itemType === "JEWELRY" && item.jewelry !== null;
    const resolved = jewelryLot ? resolveJewelryDraw(item, {}) : resolveDraw(item, {});
    if (!resolved.ok) return { ok: false, error: resolved.error };
    snapshots.push({
      lineId: line.id,
      itemId: item.id,
      currentStatus: item.status,
      draw: resolved.draw
    });
  }

  let returnDocId: string;
  try {
    returnDocId = await prisma.$transaction(
      async (tx) => {
        const seq = await tx.documentSequence.upsert({
          where: { type: "RETURN_MEMO_IN" },
          create: { type: "RETURN_MEMO_IN", lastValue: 1001 },
          update: { lastValue: { increment: 1 } }
        });
        const documentNumber = `${DOC_PREFIX.RETURN_MEMO_IN}-${seq.lastValue}`;

        const returnDoc = await tx.document.create({
          data: {
            type: "RETURN_MEMO_IN",
            documentNumber,
            status: "CLOSED",
            vendorId: memo.vendorId,
            parentDocumentId: memo.id,
            issueDate: new Date(),
            createdById: actorId
          }
        });

        await createManyChunked(
          snapshots.map((s) => {
            const item = itemById.get(s.itemId)!;
            const price = priceSnapshot(item, s.draw);
            return {
              documentId: returnDoc.id,
              inventoryItemId: s.itemId,
              lineStatus: "RETURNED" as const,
              quantity: price.quantity,
              caratWeight: price.caratWeight,
              unitPrice: price.unitPrice,
              totalPrice: price.totalPrice
            };
          }),
          (b) => tx.documentLineItem.createMany({ data: b })
        );

        const parcelBalances = new Map<string, { ct: number; qty: number | null; ids: string[] }>();
        const jewelryBalances = new Map<number, string[]>();
        for (const s of snapshots) {
          const { draw } = s;
          if (draw.lot === "PARCEL" && draw.remainingAfterCt !== null) {
            const key = `${draw.remainingAfterCt}|${draw.remainingAfterQty}`;
            const bucket = parcelBalances.get(key);
            if (bucket) bucket.ids.push(s.itemId);
            else {
              parcelBalances.set(key, {
                ct: draw.remainingAfterCt,
                qty: draw.remainingAfterQty,
                ids: [s.itemId]
              });
            }
          } else if (draw.lot === "JEWELRY" && draw.remainingAfterQty !== null) {
            const bucket = jewelryBalances.get(draw.remainingAfterQty);
            if (bucket) bucket.push(s.itemId);
            else jewelryBalances.set(draw.remainingAfterQty, [s.itemId]);
          }
        }
        for (const b of parcelBalances.values()) {
          await idsChunked(b.ids, (batch) =>
            tx.stoneDetail.updateMany({
              where: { inventoryItemId: { in: batch } },
              data: { remainingCt: b.ct, remainingQty: b.qty }
            })
          );
        }
        for (const [remainingQty, ids] of jewelryBalances) {
          await idsChunked(ids, (batch) =>
            tx.jewelryDetail.updateMany({
              where: { inventoryItemId: { in: batch } },
              data: { remainingQty }
            })
          );
        }

        await idsChunked(
          snapshots.map((s) => s.lineId),
          (batch) =>
            tx.documentLineItem.updateMany({
              where: { id: { in: batch } },
              data: { lineStatus: "RETURNED", resolvedByDocumentId: returnDoc.id }
            })
        );

        await idsChunked(
          snapshots.map((s) => s.itemId),
          (batch) =>
            tx.inventoryItem.updateMany({
              where: { id: { in: batch } },
              data: { status: "RETURNED", visibleOnPortal: false }
            })
        );
        await createManyChunked(
          snapshots.map((s) => ({
            inventoryItemId: s.itemId,
            previousStatus: s.currentStatus,
            newStatus: "RETURNED" as const,
            documentId: returnDoc.id,
            changedById: actorId
          })),
          (b) => tx.itemStatusHistory.createMany({ data: b })
        );

        await recomputeMemoClose(tx, memo.id, "IN_STOCK");

        return returnDoc.id;
      },
      { timeout: OUTBOUND_TX_TIMEOUT_MS, maxWait: 15_000 }
    );
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2028") {
      return {
        ok: false,
        error: `This return (${snapshots.length} lines) took too long to save and was rolled back — nothing was changed. Try returning fewer lines at a time.`
      };
    }
    throw e;
  }

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

/**
 * Emails the selected documents as PDF attachments, then stamps `emailedAt`.
 *
 * The stamp is written only after the provider accepts the message: unlike the
 * fire-and-forget notification emails elsewhere, sending IS the action here, so
 * a failure must surface to the operator rather than leaving a document marked
 * "Emailed" that never left the building.
 */
export async function emailDocuments(
  ids: string[],
  input: { to: string[]; subject: string; message: string }
): Promise<StampDocumentsResult> {
  const loaded = await requireDocuments(ids);
  if (!loaded.ok) return { ok: false, error: loaded.error };

  const recipients = Array.from(
    new Set(input.to.map((address) => address.trim()).filter(Boolean))
  );
  if (recipients.length === 0) {
    return { ok: false, error: "At least one recipient email address is required." };
  }

  const pdfs = await buildDocumentPdfs(loaded.unique);
  if (pdfs.length !== loaded.unique.length) {
    return { ok: false, error: "Could not render a PDF for every selected document." };
  }

  try {
    await sendDocumentEmail({
      to: recipients,
      subject: input.subject,
      message: input.message,
      attachments: pdfs.map((pdf) => ({ filename: pdf.filename, content: pdf.buffer }))
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Unknown email provider error";
    return { ok: false, error: `Email was not sent: ${detail}` };
  }

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
