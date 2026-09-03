/**
 * The seven report views (F7 · KAN-13).
 *
 * Every report here is a projection of records that already exist —
 * `InventoryItem`, `Document` + its lines, `ItemStatusHistory`. Nothing writes,
 * nothing is cached, and no report owns a table or a column: a report that needed
 * its own storage would be a second source of truth for numbers the documents
 * already settle.
 *
 * Each builder is ONE query. Reports run over the whole book, so a per-row or
 * per-document follow-up read is the shape that passes locally and dies in prod
 * — count round trips, not milliseconds.
 */

import { Prisma, prisma } from "@/db";
import { IMS_REPORT_DOCUMENT_TYPE } from "@/contract";
import type {
  DocumentType,
  ImsDocumentReportKey,
  ImsDocumentReportRow,
  ImsDocumentReportTotals,
  ImsInventoryReport,
  ImsInventoryReportRow,
  ImsInventoryReportTotals,
  ImsItemHistoryReport,
  ImsItemHistoryReportRow,
  ImsItemHistoryReportTotals,
  ImsReport,
  ImsReportEnvelope,
  ImsReportKey,
  ImsReportQuery,
  ItemStatus,
  ItemType,
  LineStatus
} from "@/contract";
import { stoneColorLabel } from "@/domain";

import { docDirectionOf } from "./documents.constants";
import { remainingPieces } from "./jewelry-lot";
import { IMS_ITEM_INCLUDE } from "./mappers";
import { remainingOf, round3 } from "./parcel";

const MS_PER_DAY = 86_400_000;

/** Items in these statuses have left the building — "current inventory" is what
 *  we still hold, so they are out unless asked for by name. */
const GONE_STATUSES: ItemStatus[] = ["SOLD", "RETURNED"];

/** Which line status still reads as "out" on a memo. An invoice, bill or PO has
 *  no line-level openness — the document's own status is its openness. */
const OPEN_LINE_STATUS: Partial<Record<DocumentType, LineStatus>> = {
  MEMO_OUT: "ON_MEMO", // ours, sitting at the client
  MEMO_IN: "IN_STOCK" // the vendor's, still on our shelf
};

function num(value: Prisma.Decimal | null): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value.toString());
  return Number.isFinite(n) ? n : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Whole calendar days between two instants, counted on UTC day boundaries. A memo
 * due today is 0 days overdue rather than a fraction of one, which is what makes
 * "overdue" mean the same thing at 9am as it does at 6pm.
 */
function daysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((b - a) / MS_PER_DAY);
}

/** Inclusive on both ends — a `to` of today includes everything logged today. */
function dateWindow(query: ImsReportQuery): { gte?: Date; lte?: Date } | undefined {
  if (!query.from && !query.to) return undefined;
  const range: { gte?: Date; lte?: Date } = {};
  if (query.from) range.gte = new Date(`${query.from}T00:00:00.000Z`);
  if (query.to) range.lte = new Date(`${query.to}T23:59:59.999Z`);
  return range;
}

function contains(q: string) {
  return { contains: q, mode: "insensitive" as const };
}

/**
 * One row over the limit is read so a capped result can say so. Callers surface
 * `truncated` rather than letting a page pass for the whole book.
 */
function page<T>(rows: T[], limit: number): { rows: T[]; truncated: boolean } {
  if (rows.length > limit) return { rows: rows.slice(0, limit), truncated: true };
  return { rows, truncated: false };
}

function emptyStatusCounts(): Record<ItemStatus, number> {
  return { IN_STOCK: 0, RESERVED: 0, ON_MEMO: 0, SOLD: 0, RETURNED: 0 };
}

function emptyTypeCounts(): Record<ItemType, number> {
  return { STONE: 0, JEWELRY: 0, OTHER_MATERIAL: 0 };
}

/* --------------------------------------------------------------- inventory */

type ReportItem = Prisma.InventoryItemGetPayload<{ include: typeof IMS_ITEM_INCLUDE }>;

/** How the piece would be quoted, from whichever detail row it carries. */
function describeItem(item: ReportItem): string {
  if (item.stone) {
    const s = item.stone;
    const ct = num(s.weightCt);
    const parts = [
      ct === null ? null : `${round3(ct)} ct`,
      s.gemType,
      s.shape,
      stoneColorLabel(s),
      s.clarity
    ];
    return parts.filter(Boolean).join(" · ") || item.itemName || item.sku;
  }
  if (item.jewelry) {
    const j = item.jewelry;
    const parts = [j.brand, j.jewelryItemType, j.metal, j.description];
    return parts.filter(Boolean).join(" · ") || item.itemName || item.sku;
  }
  if (item.material) {
    const m = item.material;
    const parts = [m.category, m.subtype, m.metalType, m.size];
    return parts.filter(Boolean).join(" · ") || item.itemName || item.sku;
  }
  return item.itemName ?? item.sku;
}

type ItemBalanceValues = Pick<
  ImsInventoryReportRow,
  | "originalCt"
  | "remainingCt"
  | "originalQty"
  | "remainingQty"
  | "costValue"
  | "wholesaleValue"
  | "retailValue"
>;

/**
 * What the shelf is actually worth. A lot that has been drawn down is worth what
 * is LEFT in it: a per-carat / per-piece price applies to the remaining balance,
 * and a stored line total — struck against the full weight when the lot arrived —
 * is pro-rated by the same ratio. A parcel is priced linearly in carats, so the
 * two routes agree; an untouched item pro-rates by 1 and reads exactly as the
 * document snapshots price it.
 */
function valueItem(item: ReportItem): ItemBalanceValues {
  if (item.stone) {
    const s = item.stone;
    const originalCt = num(s.weightCt);
    const balance = remainingOf(s);
    const ratio = originalCt !== null && originalCt > 0 ? Math.min(1, balance.ct / originalCt) : 1;
    const value = (perCt: Prisma.Decimal | null, stored: Prisma.Decimal | null): number | null => {
      const rate = num(perCt);
      if (rate !== null) return round2(rate * balance.ct);
      const total = num(stored);
      return total === null ? null : round2(total * ratio);
    };
    return {
      originalCt,
      remainingCt: balance.ct,
      originalQty: s.quantity,
      remainingQty: balance.qty,
      costValue: value(s.costPerCt, s.totalCost),
      wholesaleValue: value(s.wholesalePricePerCt, s.totalWholesalePrice),
      retailValue: value(s.retailPricePerCt, s.totalRetailPrice)
    };
  }

  if (item.jewelry) {
    const j = item.jewelry;
    const pieces = remainingPieces(j);
    // Jewelry and material prices are per PIECE, so a lot of 3 is worth 3x.
    const value = (unit: Prisma.Decimal | null): number | null => {
      const rate = num(unit);
      return rate === null ? null : round2(rate * pieces);
    };
    return {
      originalCt: null,
      remainingCt: null,
      originalQty: j.quantity,
      remainingQty: pieces,
      costValue: value(j.productionCost),
      wholesaleValue: value(j.wholesalePrice),
      retailValue: value(j.retailPrice)
    };
  }

  if (item.material) {
    const m = item.material;
    const value = (unit: Prisma.Decimal | null): number | null => {
      const rate = num(unit);
      return rate === null ? null : round2(rate * m.quantity);
    };
    return {
      originalCt: null,
      remainingCt: null,
      // Findings and materials carry no draw-down balance — the lot is the lot.
      originalQty: m.quantity,
      remainingQty: m.quantity,
      costValue: value(m.cost),
      wholesaleValue: value(m.wholesalePrice),
      retailValue: null
    };
  }

  return {
    originalCt: null,
    remainingCt: null,
    originalQty: null,
    remainingQty: null,
    costValue: null,
    wholesaleValue: null,
    retailValue: null
  };
}

function inventoryRow(item: ReportItem): ImsInventoryReportRow {
  const stone = item.stone;
  return {
    id: item.id,
    sku: item.sku,
    vendorSku: item.vendorSku,
    itemName: item.itemName,
    itemType: item.itemType,
    itemSubtype: item.itemSubtype,
    status: item.status,
    vendorName: item.vendor?.name ?? null,
    brandOwnerName: item.brandOwner?.name ?? null,
    reservedForClientName: item.reservedForClient?.name ?? null,
    description: describeItem(item),
    gemType: stone?.gemType ?? null,
    shape: stone?.shape ?? null,
    color: stone ? stoneColorLabel(stone) : null,
    clarity: stone?.clarity ?? null,
    lab: stone?.lab ?? null,
    certNumber: stone?.certNumber ?? item.jewelry?.certNumber ?? null,
    ...valueItem(item),
    visibleOnPortal: item.visibleOnPortal,
    enteredStockAt: item.enteredStockAt.toISOString()
  };
}

function inventoryWhere(query: ImsReportQuery): Prisma.InventoryItemWhereInput {
  const where: Prisma.InventoryItemWhereInput = {
    status: query.itemStatus ?? { notIn: GONE_STATUSES }
  };
  if (query.vendorId) where.vendorId = query.vendorId;

  const window = dateWindow(query);
  if (window) where.enteredStockAt = window;

  const and: Prisma.InventoryItemWhereInput[] = [];
  if (query.clientId) {
    // A client touches stock two ways: they own it (a brand we hold) or it is
    // being held for them.
    and.push({
      OR: [{ brandOwnerId: query.clientId }, { reservedForClientId: query.clientId }]
    });
  }
  if (query.q) {
    const like = contains(query.q);
    and.push({ OR: [{ sku: like }, { vendorSku: like }, { itemName: like }] });
  }
  if (and.length > 0) where.AND = and;

  return where;
}

function inventoryTotals(rows: ImsInventoryReportRow[]): ImsInventoryReportTotals {
  const byStatus = emptyStatusCounts();
  const byType = emptyTypeCounts();
  let remainingCarats = 0;
  let costValue = 0;
  let wholesaleValue = 0;
  let retailValue = 0;
  let valuedItemCount = 0;

  for (const row of rows) {
    byStatus[row.status] += 1;
    byType[row.itemType] += 1;
    remainingCarats += row.remainingCt ?? 0;
    costValue += row.costValue ?? 0;
    wholesaleValue += row.wholesaleValue ?? 0;
    retailValue += row.retailValue ?? 0;
    if (row.wholesaleValue !== null) valuedItemCount += 1;
  }

  return {
    itemCount: rows.length,
    byStatus,
    byType,
    remainingCarats: round3(remainingCarats),
    costValue: round2(costValue),
    wholesaleValue: round2(wholesaleValue),
    retailValue: round2(retailValue),
    valuedItemCount
  };
}

export async function buildInventoryReport(query: ImsReportQuery): Promise<ImsInventoryReport> {
  const generatedAt = new Date().toISOString();
  const items = await prisma.inventoryItem.findMany({
    where: inventoryWhere(query),
    include: IMS_ITEM_INCLUDE,
    orderBy: [{ enteredStockAt: "desc" }, { sku: "asc" }],
    take: query.limit + 1
  });

  const { rows: kept, truncated } = page(items, query.limit);
  const rows = kept.map(inventoryRow);

  return {
    key: "inventory",
    generatedAt,
    rowCount: rows.length,
    truncated,
    rowLimit: query.limit,
    totals: inventoryTotals(rows),
    rows
  };
}

/* --------------------------------------------------------------- documents */

const DOCUMENT_REPORT_SELECT = {
  id: true,
  type: true,
  documentNumber: true,
  externalReference: true,
  status: true,
  vendorId: true,
  clientId: true,
  issueDate: true,
  dueDate: true,
  discountAmount: true,
  emailedAt: true,
  quickbooksSyncedAt: true,
  vendor: { select: { name: true } },
  client: { select: { name: true } },
  lineItems: { select: { lineStatus: true, totalPrice: true } }
} satisfies Prisma.DocumentSelect;

type ReportDocument = Prisma.DocumentGetPayload<{ select: typeof DOCUMENT_REPORT_SELECT }>;

function documentRow(doc: ReportDocument, now: Date): ImsDocumentReportRow {
  const direction = docDirectionOf(doc.type);
  const discount = num(doc.discountAmount);

  // Same arithmetic as the document DTO: unpriced lines leave the total null
  // rather than reading as zero, and only an outbound document takes a discount.
  const priced = doc.lineItems
    .map((l) => num(l.totalPrice))
    .filter((v): v is number => v !== null);
  const subtotal = priced.reduce((sum, v) => sum + v, 0);
  const total =
    priced.length === 0
      ? null
      : round2(direction === "out" ? Math.max(0, subtotal - (discount ?? 0)) : subtotal);

  const openStatus = OPEN_LINE_STATUS[doc.type];
  let openLineCount: number | null = null;
  let openValue: number | null = null;
  if (openStatus) {
    const open = doc.lineItems.filter((l) => l.lineStatus === openStatus);
    openLineCount = open.length;
    openValue = round2(open.reduce((sum, l) => sum + (num(l.totalPrice) ?? 0), 0));
  }

  const daysPastDue = doc.dueDate ? daysBetween(doc.dueDate, now) : null;
  // Only an OPEN document can be overdue: a memo that came back or was invoiced
  // is settled, whatever its due date said.
  const overdue = doc.status === "OPEN" && daysPastDue !== null && daysPastDue > 0;

  return {
    id: doc.id,
    type: doc.type,
    documentNumber: doc.documentNumber,
    externalReference: doc.externalReference,
    status: doc.status,
    direction,
    partyKind: doc.vendorId ? "vendor" : doc.clientId ? "client" : null,
    partyId: doc.vendorId ?? doc.clientId ?? null,
    partyName: doc.vendor?.name ?? doc.client?.name ?? null,
    issueDate: doc.issueDate.toISOString(),
    dueDate: doc.dueDate?.toISOString() ?? null,
    daysOutstanding: Math.max(0, daysBetween(doc.issueDate, now)),
    overdue,
    daysOverdue: overdue ? daysPastDue : null,
    lineCount: doc.lineItems.length,
    openLineCount,
    openValue,
    total,
    emailedAt: doc.emailedAt?.toISOString() ?? null,
    quickbooksSyncedAt: doc.quickbooksSyncedAt?.toISOString() ?? null
  };
}

function documentWhere(type: DocumentType, query: ImsReportQuery): Prisma.DocumentWhereInput {
  const where: Prisma.DocumentWhereInput = {
    type,
    // A voided document is not business activity, so it stays out of every report
    // unless it is what was asked for.
    status: query.documentStatus ?? { not: "VOID" }
  };
  if (query.vendorId) where.vendorId = query.vendorId;
  if (query.clientId) where.clientId = query.clientId;

  const window = dateWindow(query);
  if (window) where.issueDate = window;

  if (query.q) {
    const like = contains(query.q);
    where.OR = [
      { documentNumber: like },
      { externalReference: like },
      { vendor: { name: like } },
      { client: { name: like } }
    ];
  }

  return where;
}

function documentTotals(
  rows: ImsDocumentReportRow[],
  tracksOpenLines: boolean
): ImsDocumentReportTotals {
  let openCount = 0;
  let overdueCount = 0;
  let lineCount = 0;
  let openLineCount = 0;
  let totalValue = 0;
  let openValue = 0;
  let unsyncedCount = 0;

  for (const row of rows) {
    if (row.status === "OPEN") openCount += 1;
    if (row.overdue) overdueCount += 1;
    lineCount += row.lineCount;
    openLineCount += row.openLineCount ?? 0;
    totalValue += row.total ?? 0;
    openValue += row.openValue ?? 0;
    if (row.quickbooksSyncedAt === null) unsyncedCount += 1;
  }

  return {
    documentCount: rows.length,
    openCount,
    overdueCount,
    lineCount,
    openLineCount: tracksOpenLines ? openLineCount : null,
    totalValue: round2(totalValue),
    openValue: tracksOpenLines ? round2(openValue) : null,
    unsyncedCount
  };
}

/**
 * Memo Out / Memo In / PO / Invoices / Bills are the same projection over
 * different document types, so they share one builder and one row shape. That row
 * carries only the counterparty's name — no client, no wholesale price — which is
 * what keeps the PO report safe to hand to a vendor.
 */
export async function buildDocumentReport<K extends ImsDocumentReportKey>(
  key: K,
  query: ImsReportQuery
): Promise<ImsReportEnvelope<K, ImsDocumentReportTotals, ImsDocumentReportRow>> {
  const now = new Date();
  const type: DocumentType = IMS_REPORT_DOCUMENT_TYPE[key];

  const docs = await prisma.document.findMany({
    where: documentWhere(type, query),
    select: DOCUMENT_REPORT_SELECT,
    orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }],
    take: query.limit + 1
  });

  const { rows: kept, truncated } = page(docs, query.limit);
  const rows = kept.map((doc) => documentRow(doc, now));

  return {
    key,
    generatedAt: now.toISOString(),
    rowCount: rows.length,
    truncated,
    rowLimit: query.limit,
    totals: documentTotals(rows, OPEN_LINE_STATUS[type] !== undefined),
    rows
  };
}

/* ----------------------------------------------------------------- history */

const HISTORY_REPORT_SELECT = {
  id: true,
  changedAt: true,
  previousStatus: true,
  newStatus: true,
  note: true,
  inventoryItemId: true,
  changedById: true,
  documentId: true,
  inventoryItem: { select: { sku: true, itemName: true, itemType: true, status: true } },
  document: {
    select: {
      documentNumber: true,
      type: true,
      vendor: { select: { name: true } },
      client: { select: { name: true } }
    }
  },
  changedBy: { select: { fullName: true } }
} satisfies Prisma.ItemStatusHistorySelect;

type ReportHistoryEvent = Prisma.ItemStatusHistoryGetPayload<{
  select: typeof HISTORY_REPORT_SELECT;
}>;

function historyRow(event: ReportHistoryEvent): ImsItemHistoryReportRow {
  return {
    id: event.id,
    changedAt: event.changedAt.toISOString(),
    inventoryItemId: event.inventoryItemId,
    sku: event.inventoryItem.sku,
    itemName: event.inventoryItem.itemName,
    itemType: event.inventoryItem.itemType,
    currentStatus: event.inventoryItem.status,
    previousStatus: event.previousStatus,
    newStatus: event.newStatus,
    documentId: event.documentId,
    documentNumber: event.document?.documentNumber ?? null,
    documentType: event.document?.type ?? null,
    partyName: event.document?.vendor?.name ?? event.document?.client?.name ?? null,
    changedById: event.changedById,
    changedByName: event.changedBy?.fullName ?? null,
    note: event.note
  };
}

function historyWhere(query: ImsReportQuery): Prisma.ItemStatusHistoryWhereInput {
  const where: Prisma.ItemStatusHistoryWhereInput = {};
  if (query.itemId) where.inventoryItemId = query.itemId;
  if (query.itemStatus) where.newStatus = query.itemStatus;

  const window = dateWindow(query);
  if (window) where.changedAt = window;

  const and: Prisma.ItemStatusHistoryWhereInput[] = [];
  if (query.vendorId) and.push({ document: { vendorId: query.vendorId } });
  if (query.clientId) and.push({ document: { clientId: query.clientId } });
  if (query.q) {
    const like = contains(query.q);
    and.push({
      inventoryItem: { OR: [{ sku: like }, { vendorSku: like }, { itemName: like }] }
    });
  }
  if (and.length > 0) where.AND = and;

  return where;
}

function historyTotals(rows: ImsItemHistoryReportRow[]): ImsItemHistoryReportTotals {
  const byStatus = emptyStatusCounts();
  const items = new Set<string>();
  for (const row of rows) {
    byStatus[row.newStatus] += 1;
    items.add(row.inventoryItemId);
  }
  return { eventCount: rows.length, itemCount: items.size, byStatus };
}

/**
 * The audit trail, grouped by SKU and read forwards inside each one — a
 * lifecycle rather than a feed, which is what makes "received → memo'd →
 * returned → sold" legible on one screen.
 */
export async function buildItemHistoryReport(
  query: ImsReportQuery
): Promise<ImsItemHistoryReport> {
  const generatedAt = new Date().toISOString();
  const events = await prisma.itemStatusHistory.findMany({
    where: historyWhere(query),
    select: HISTORY_REPORT_SELECT,
    orderBy: [{ inventoryItem: { sku: "asc" } }, { changedAt: "asc" }],
    take: query.limit + 1
  });

  const { rows: kept, truncated } = page(events, query.limit);
  const rows = kept.map(historyRow);

  return {
    key: "history",
    generatedAt,
    rowCount: rows.length,
    truncated,
    rowLimit: query.limit,
    totals: historyTotals(rows),
    rows
  };
}

export async function buildReport(key: ImsReportKey, query: ImsReportQuery): Promise<ImsReport> {
  switch (key) {
    case "inventory":
      return buildInventoryReport(query);
    case "history":
      return buildItemHistoryReport(query);
    default:
      return buildDocumentReport(key, query);
  }
}
