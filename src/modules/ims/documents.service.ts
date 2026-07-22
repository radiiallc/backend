import { Prisma, prisma } from "@/db";
import type { CloseReason as PrismaCloseReason, DocumentType as PrismaDocumentType } from "@/db";
import type {
  ImsCreateDocument,
  ImsCreateInboundDocument,
  ImsCreatePurchaseOrder,
  ImsDocument,
  ImsRecordReturn
} from "@/contract";

import {
  ALLOWED_SOURCE_STATUS,
  DOC_PREFIX,
  NEW_ITEM_STATUS,
  NEW_LINE_STATUS,
  type OutboundCreateType
} from "./documents.constants";
import { IMS_DOC_INCLUDE, prismaDocToDto } from "./documents.mappers";
import { buildInboundItemCreateData, mintSkuBatch } from "./inventory.service";

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
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

    // Invoice-from-memo (admin #0025 lifecycle): when an INVOICE sells a stone
    // that was still ON_MEMO, resolve its originating open memo line to SOLD,
    // linked to this invoice, and recompute that memo's close state. This closes
    // the memo↔invoice coupling gap — the invoice IS the resolving document, the
    // mirror of a return doc resolving a line to RETURNED.
    if (type === "INVOICE") {
      const soldFromMemo = snapshots.filter((s) => s.currentStatus === "ON_MEMO");
      const affectedMemoIds = new Set<string>();
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
  const now = new Date();

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
        issueDate: now,
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
//     create, which writes none). dueDate pre-fills from the vendor's terms.
// Transactional with a batch SKU mint + whole-tx retry on a sku race. NOTE: a very
// large bulk migration (case A) may need chunking/timeout tuning; the ongoing
// per-document receive (case B) is well within one tx.
export async function createInboundDocument(
  input: ImsCreateInboundDocument,
  createdById: string
): Promise<CreateDocumentResult> {
  const vendor = await prisma.vendor.findUnique({
    where: { id: input.vendorId },
    select: { id: true, defaultMemoTermsDays: true, defaultInvoiceTermsDays: true }
  });
  if (!vendor) return { ok: false, error: "Vendor not found" };

  const now = new Date();
  const termDays =
    input.type === "MEMO_IN" ? vendor.defaultMemoTermsDays : vendor.defaultInvoiceTermsDays;
  const dueDate = termDays ? new Date(now.getTime() + termDays * 86_400_000) : null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const docId = await prisma.$transaction(
        async (tx) => {
          const skus = await mintSkuBatch(tx, input.items.length);

          const lines: Array<{ inventoryItemId: string } & ReturnType<typeof costSnapshot>> = [];
          const createdItemIds: string[] = [];
          for (let i = 0; i < input.items.length; i++) {
            const data = buildInboundItemCreateData(input.items[i], input.vendorId, skus[i]);
            const item = await tx.inventoryItem.create({
              data,
              include: { stone: true, jewelry: true, material: true }
            });
            createdItemIds.push(item.id);
            lines.push({ inventoryItemId: item.id, ...costSnapshot(item) });
          }

          const doc = await tx.document.create({
            data: {
              type: input.type,
              documentNumber: null, // inbound uses the vendor's own reference
              externalReference: input.externalReference ?? null,
              status: "OPEN",
              vendorId: input.vendorId,
              issueDate: now,
              dueDate,
              notes: input.notes ?? null,
              createdById,
              lineItems: {
                create: lines.map((l) => ({
                  inventoryItemId: l.inventoryItemId,
                  lineStatus: "IN_STOCK" as const,
                  quantity: l.quantity,
                  caratWeight: l.caratWeight,
                  unitPrice: l.unitPrice,
                  totalPrice: l.totalPrice
                }))
              }
            }
          });

          // Provenance: each item was brought into stock THROUGH this document.
          for (const inventoryItemId of createdItemIds) {
            await tx.itemStatusHistory.create({
              data: {
                inventoryItemId,
                previousStatus: null,
                newStatus: "IN_STOCK",
                documentId: doc.id,
                changedById: createdById
              }
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
