import { prisma, Prisma } from "@/db";
import type {
  DocumentDetail,
  DocumentLineDto,
  DocumentListParams,
  DocumentListResult,
  DocumentListRow,
  DocumentSortKey
} from "@/contract";

import { computeDocumentTotals } from "./discount";

// ────────────────────────────────────────────────────────────────────────────
// Document read services (§H4 / §7 reporting). The list query is read-trimmed —
// header fields + a computed total + an overdue flag (the open-memo reports
// highlight these). The detail returns the full header, every line with its item
// summary + computed line total, and the document totals (discount math §6.7).
// ────────────────────────────────────────────────────────────────────────────

function dec(d: Prisma.Decimal | null): number | null {
  return d == null ? null : Number(d);
}

// Overdue = dueDate < today AND status OPEN. A calculated flag, never a status
// (spec §4 note / §reporting). Computed against the start of today so a doc due
// "today" is not yet overdue.
function isOverdue(dueDate: Date | null, status: string): boolean {
  if (!dueDate || status !== "OPEN") return false;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  return dueDate.getTime() < startOfToday.getTime();
}

// Short human label for a line's item, per type (mirrors the inventory list).
type ItemSummarySource = {
  itemType: string;
  stoneDetail: { weightCt: Prisma.Decimal | null; gemType: string | null; shape: string | null; color: string | null; clarity: string | null } | null;
  jewelryDetail: { brand: string | null; jewelryItemType: string | null; metal: string | null } | null;
  otherMaterialDetail: { subtype: string | null; metalType: string | null } | null;
};

function summarizeItem(item: ItemSummarySource): string {
  if (item.itemType === "STONE" && item.stoneDetail) {
    const s = item.stoneDetail;
    return [s.weightCt ? `${Number(s.weightCt)}ct` : null, s.gemType, s.shape, s.color, s.clarity]
      .filter(Boolean)
      .join(" ");
  }
  if (item.itemType === "JEWELRY" && item.jewelryDetail) {
    const j = item.jewelryDetail;
    return [j.brand, j.jewelryItemType, j.metal].filter(Boolean).join(" ");
  }
  if (item.itemType === "OTHER_MATERIAL" && item.otherMaterialDetail) {
    const o = item.otherMaterialDetail;
    return [o.subtype?.replace(/_/g, " ").toLowerCase(), o.metalType].filter(Boolean).join(" ");
  }
  return "";
}

// ── List ───────────────────────────────────────────────────────────────────
function buildWhere(params: DocumentListParams): Prisma.DocumentWhereInput {
  const where: Prisma.DocumentWhereInput = {};
  if (params.type) where.type = params.type;
  if (params.status) where.status = params.status;
  if (params.vendorId) where.vendorId = params.vendorId;
  if (params.clientId) where.clientId = params.clientId;

  if (params.overdueOnly) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    where.status = "OPEN";
    where.dueDate = { lt: startOfToday };
  }

  if (params.query) {
    const contains = { contains: params.query, mode: "insensitive" as const };
    where.OR = [{ documentNumber: contains }, { externalReference: contains }];
  }
  return where;
}

function buildOrderBy(sort: DocumentSortKey): Prisma.DocumentOrderByWithRelationInput {
  switch (sort) {
    case "oldest":
      return { issueDate: "asc" };
    case "due-asc":
      return { dueDate: "asc" };
    case "due-desc":
      return { dueDate: "desc" };
    case "newest":
    default:
      return { issueDate: "desc" };
  }
}

const LIST_LINE_SELECT = {
  quantity: true,
  unitPrice: true,
  totalPrice: true,
  discountAmount: true
} satisfies Prisma.DocumentLineItemSelect;

export async function listDocuments(params: DocumentListParams): Promise<DocumentListResult> {
  const where = buildWhere(params);
  const perPage = Math.min(Math.max(params.perPage, 1), 200);
  const page = Math.max(params.page, 1);

  const [rows, total] = await Promise.all([
    prisma.document.findMany({
      where,
      select: {
        id: true,
        type: true,
        documentNumber: true,
        externalReference: true,
        status: true,
        issueDate: true,
        dueDate: true,
        createdAt: true,
        vendor: { select: { name: true } },
        client: { select: { name: true } },
        lineItems: { select: LIST_LINE_SELECT }
      },
      orderBy: buildOrderBy(params.sort),
      skip: (page - 1) * perPage,
      take: perPage
    }),
    prisma.document.count({ where })
  ]);

  const items: DocumentListRow[] = rows.map((row) => {
    const totals = computeDocumentTotals(
      row.lineItems.map((l) => ({
        quantity: l.quantity,
        unitPrice: dec(l.unitPrice),
        totalPrice: dec(l.totalPrice),
        discountAmount: dec(l.discountAmount)
      })),
      null // header discount excluded from the list total query — kept on detail
    );
    return {
      id: row.id,
      type: row.type,
      documentNumber: row.documentNumber,
      externalReference: row.externalReference,
      status: row.status,
      partyName: row.vendor?.name ?? row.client?.name ?? null,
      issueDate: row.issueDate.toISOString(),
      dueDate: row.dueDate?.toISOString() ?? null,
      overdue: isOverdue(row.dueDate, row.status),
      lineCount: row.lineItems.length,
      total: totals.subtotal,
      createdAt: row.createdAt.toISOString()
    };
  });

  return {
    items,
    total,
    page,
    perPage,
    totalPages: Math.max(1, Math.ceil(total / perPage))
  };
}

// ── Detail ───────────────────────────────────────────────────────────────────
export async function getDocument(id: string): Promise<DocumentDetail | null> {
  const doc = await prisma.document.findUnique({
    where: { id },
    include: {
      vendor: { select: { name: true } },
      client: { select: { name: true } },
      createdBy: { select: { fullName: true } },
      lineItems: {
        orderBy: { createdAt: "asc" },
        include: {
          inventoryItem: {
            select: {
              sku: true,
              itemType: true,
              stoneDetail: {
                select: { weightCt: true, gemType: true, shape: true, color: true, clarity: true }
              },
              jewelryDetail: { select: { brand: true, jewelryItemType: true, metal: true } },
              otherMaterialDetail: { select: { subtype: true, metalType: true } }
            }
          }
        }
      }
    }
  });
  if (!doc) return null;

  const totals = computeDocumentTotals(
    doc.lineItems.map((l) => ({
      quantity: l.quantity,
      unitPrice: dec(l.unitPrice),
      totalPrice: dec(l.totalPrice),
      discountAmount: dec(l.discountAmount)
    })),
    dec(doc.discountAmount)
  );

  const lines: DocumentLineDto[] = doc.lineItems.map((l, i) => ({
    id: l.id,
    inventoryItemId: l.inventoryItemId,
    sku: l.inventoryItem.sku,
    summary: summarizeItem(l.inventoryItem),
    lineStatus: l.lineStatus,
    quantity: l.quantity,
    caratWeight: dec(l.caratWeight),
    unitPrice: dec(l.unitPrice),
    totalPrice: dec(l.totalPrice),
    discountAmount: dec(l.discountAmount),
    lineTotal: totals.lineTotals[i] ?? 0,
    clientReference: l.clientReference,
    notes: l.notes
  }));

  return {
    id: doc.id,
    type: doc.type,
    documentNumber: doc.documentNumber,
    externalReference: doc.externalReference,
    status: doc.status,
    vendorId: doc.vendorId,
    vendorName: doc.vendor?.name ?? null,
    clientId: doc.clientId,
    clientName: doc.client?.name ?? null,
    issueDate: doc.issueDate.toISOString(),
    dueDate: doc.dueDate?.toISOString() ?? null,
    projectJob: doc.projectJob,
    discountAmount: dec(doc.discountAmount),
    notes: doc.notes,
    emailedAt: doc.emailedAt?.toISOString() ?? null,
    linkedPoId: doc.linkedPoId,
    billedPoId: doc.billedPoId,
    overdue: isOverdue(doc.dueDate, doc.status),
    createdByName: doc.createdBy?.fullName ?? null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    lines,
    totals: {
      grossSubtotal: totals.grossSubtotal,
      lineDiscountTotal: totals.lineDiscountTotal,
      subtotal: totals.subtotal,
      documentDiscount: totals.documentDiscount,
      total: totals.total
    }
  };
}

// ── Query-bag parser (Express req.query → typed params) ──────────────────────
type QueryValue = string | string[] | undefined;

function one(v: QueryValue): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  const t = s?.trim();
  return t ? t : undefined;
}

const DOC_TYPES = [
  "BILL_IN",
  "MEMO_IN",
  "BRAND_INVENTORY_IN",
  "MEMO_OUT",
  "CONSIGNMENT_OUT",
  "INVOICE",
  "PURCHASE_ORDER",
  "RETURN_MEMO_OUT",
  "RETURN_MEMO_IN",
  "BRAND_INVENTORY_OUT"
];
const DOC_STATUSES = ["OPEN", "CLOSED", "EXPORTED", "BILLED", "VOID"];
const DOC_SORTS = ["newest", "oldest", "due-asc", "due-desc"];

export function parseDocumentListParams(q: Record<string, QueryValue>): DocumentListParams {
  const num = (v: QueryValue, fallback: number): number => {
    const n = Number(one(v));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  const typeRaw = one(q.type);
  const statusRaw = one(q.status);
  const sortRaw = one(q.sort);

  return {
    type: (DOC_TYPES.includes(typeRaw ?? "") ? typeRaw : undefined) as DocumentListParams["type"],
    status: (DOC_STATUSES.includes(statusRaw ?? "")
      ? statusRaw
      : undefined) as DocumentListParams["status"],
    vendorId: one(q.vendorId),
    clientId: one(q.clientId),
    overdueOnly: one(q.overdueOnly) === "true",
    query: one(q.q),
    sort: (DOC_SORTS.includes(sortRaw ?? "") ? sortRaw : "newest") as DocumentSortKey,
    page: num(q.page, 1),
    perPage: num(q.perPage, 50)
  };
}
