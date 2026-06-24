import { prisma, Prisma } from "@/db";
import type {
  InventoryItemDetail,
  InventoryListParams,
  InventoryListResult,
  InventoryListRow,
  ItemStatusHistoryRow,
  JewelryDetailInput,
  LinkedDocumentRow,
  OtherMaterialDetailInput,
  StoneDetailDto
} from "@/contract";

// ────────────────────────────────────────────────────────────────────────────
// Inventory read services (§H3.1). The list query is read-trimmed (mirrors the
// catalog's DIAMOND_CARD_SELECT discipline, WORKPLAN §A6): it selects only what
// the table renders — no full media payloads beyond the booleans needed for the
// "has media" badge/filter. getInventoryItem returns the full detail + status
// history + linked documents for the item page.
// ────────────────────────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function dec(d: Prisma.Decimal | null): number | null {
  return d == null ? null : Number(d);
}

function daysInStock(enteredStockAt: Date): number {
  return Math.max(0, Math.floor((Date.now() - enteredStockAt.getTime()) / MS_PER_DAY));
}

// ── List ─────────────────────────────────────────────────────────────────────
const LIST_SELECT = {
  id: true,
  sku: true,
  itemType: true,
  itemSubtype: true,
  status: true,
  visibleOnPortal: true,
  enteredStockAt: true,
  vendor: { select: { name: true } },
  brandOwner: { select: { name: true } },
  stoneDetail: {
    select: {
      weightCt: true,
      shape: true,
      color: true,
      clarity: true,
      gemType: true,
      totalWholesalePrice: true,
      photo1Url: true,
      photo2Url: true,
      videoUrl: true
    }
  },
  jewelryDetail: {
    select: { brand: true, jewelryItemType: true, metal: true, wholesalePrice: true }
  },
  otherMaterialDetail: { select: { subtype: true, metalType: true, cost: true } }
} satisfies Prisma.InventoryItemSelect;

type ListRow = Prisma.InventoryItemGetPayload<{ select: typeof LIST_SELECT }>;

function summarize(row: ListRow): string {
  if (row.itemType === "STONE" && row.stoneDetail) {
    const s = row.stoneDetail;
    return [s.weightCt ? `${Number(s.weightCt)}ct` : null, s.gemType, s.shape, s.color, s.clarity]
      .filter(Boolean)
      .join(" ");
  }
  if (row.itemType === "JEWELRY" && row.jewelryDetail) {
    const j = row.jewelryDetail;
    return [j.brand, j.jewelryItemType, j.metal].filter(Boolean).join(" ");
  }
  if (row.itemType === "OTHER_MATERIAL" && row.otherMaterialDetail) {
    const o = row.otherMaterialDetail;
    return [o.subtype?.replace(/_/g, " ").toLowerCase(), o.metalType].filter(Boolean).join(" ");
  }
  return "";
}

function listPrice(row: ListRow): number | null {
  if (row.stoneDetail?.totalWholesalePrice != null) return Number(row.stoneDetail.totalWholesalePrice);
  if (row.jewelryDetail?.wholesalePrice != null) return Number(row.jewelryDetail.wholesalePrice);
  if (row.otherMaterialDetail?.cost != null) return Number(row.otherMaterialDetail.cost);
  return null;
}

function hasMedia(row: ListRow): boolean {
  const s = row.stoneDetail;
  return Boolean(s && (s.photo1Url || s.photo2Url || s.videoUrl));
}

function buildWhere(params: InventoryListParams): Prisma.InventoryItemWhereInput {
  const where: Prisma.InventoryItemWhereInput = {};
  if (params.status) where.status = params.status;
  if (params.itemType) where.itemType = params.itemType;
  if (params.vendorId) where.vendorId = params.vendorId;
  if (params.brandOwnerId) where.brandOwnerId = params.brandOwnerId;
  if (params.visibleOnPortal !== undefined) where.visibleOnPortal = params.visibleOnPortal;

  if (params.media === "with") {
    where.stoneDetail = {
      OR: [
        { photo1Url: { not: null } },
        { photo2Url: { not: null } },
        { videoUrl: { not: null } }
      ]
    };
  } else if (params.media === "without") {
    where.OR = [
      { stoneDetail: null },
      {
        stoneDetail: {
          photo1Url: null,
          photo2Url: null,
          videoUrl: null
        }
      }
    ];
  }

  if (params.query) {
    const q = params.query;
    const contains = { contains: q, mode: "insensitive" as const };
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
      {
        OR: [
          { sku: contains },
          { notes: contains },
          { stoneDetail: { gemType: contains } },
          { stoneDetail: { shape: contains } }
        ]
      }
    ];
  }
  return where;
}

function buildOrderBy(
  sort: InventoryListParams["sort"]
): Prisma.InventoryItemOrderByWithRelationInput {
  switch (sort) {
    case "oldest":
      return { createdAt: "asc" };
    case "sku-asc":
      return { sku: "asc" };
    case "sku-desc":
      return { sku: "desc" };
    case "price-asc":
      return { stoneDetail: { totalWholesalePrice: "asc" } };
    case "price-desc":
      return { stoneDetail: { totalWholesalePrice: "desc" } };
    case "days-in-stock-desc":
      return { enteredStockAt: "asc" }; // oldest entry = most days in stock
    case "days-in-stock-asc":
      return { enteredStockAt: "desc" };
    case "newest":
    default:
      return { createdAt: "desc" };
  }
}

export async function listInventoryItems(
  params: InventoryListParams
): Promise<InventoryListResult> {
  const where = buildWhere(params);
  const perPage = Math.min(Math.max(params.perPage, 1), 200);
  const page = Math.max(params.page, 1);

  const [rows, total] = await Promise.all([
    prisma.inventoryItem.findMany({
      where,
      select: LIST_SELECT,
      orderBy: buildOrderBy(params.sort),
      skip: (page - 1) * perPage,
      take: perPage
    }),
    prisma.inventoryItem.count({ where })
  ]);

  const items: InventoryListRow[] = rows.map((row) => ({
    id: row.id,
    sku: row.sku,
    itemType: row.itemType,
    itemSubtype: row.itemSubtype,
    status: row.status,
    visibleOnPortal: row.visibleOnPortal,
    vendorName: row.vendor?.name ?? null,
    brandOwnerName: row.brandOwner?.name ?? null,
    enteredStockAt: row.enteredStockAt.toISOString(),
    daysInStock: daysInStock(row.enteredStockAt),
    summary: summarize(row),
    totalWholesalePrice: listPrice(row),
    hasMedia: hasMedia(row)
  }));

  return {
    items,
    total,
    page,
    perPage,
    totalPages: Math.max(1, Math.ceil(total / perPage))
  };
}

// ── Detail ───────────────────────────────────────────────────────────────────
export async function getInventoryItem(id: string): Promise<InventoryItemDetail | null> {
  const item = await prisma.inventoryItem.findUnique({
    where: { id },
    include: {
      vendor: { select: { name: true } },
      brandOwner: { select: { name: true } },
      reservedForClient: { select: { name: true } },
      stoneDetail: true,
      jewelryDetail: true,
      otherMaterialDetail: true,
      statusHistory: {
        orderBy: { changedAt: "desc" },
        include: { changedBy: { select: { fullName: true } } }
      },
      lineItems: {
        include: { document: true },
        orderBy: { createdAt: "desc" }
      }
    }
  });
  if (!item) return null;

  const stone: StoneDetailDto | null = item.stoneDetail
    ? {
        gemType: item.stoneDetail.gemType,
        shape: item.stoneDetail.shape,
        weightCt: dec(item.stoneDetail.weightCt),
        quantity: item.stoneDetail.quantity,
        color: item.stoneDetail.color,
        fancyColor: item.stoneDetail.fancyColor,
        fancyIntensity: item.stoneDetail.fancyIntensity,
        fancyOvertone: item.stoneDetail.fancyOvertone,
        clarity: item.stoneDetail.clarity,
        cutGrade: item.stoneDetail.cutGrade,
        polish: item.stoneDetail.polish,
        symmetry: item.stoneDetail.symmetry,
        fluorescence: item.stoneDetail.fluorescence,
        lengthMm: dec(item.stoneDetail.lengthMm),
        widthMm: dec(item.stoneDetail.widthMm),
        heightMm: dec(item.stoneDetail.heightMm),
        depthPct: dec(item.stoneDetail.depthPct),
        tablePct: dec(item.stoneDetail.tablePct),
        girdle: item.stoneDetail.girdle,
        lab: item.stoneDetail.lab,
        certNumber: item.stoneDetail.certNumber,
        certUrl: item.stoneDetail.certUrl,
        naturalOrLab: item.stoneDetail.naturalOrLab,
        origin: item.stoneDetail.origin,
        treatment: item.stoneDetail.treatment,
        wholesalePricePerCt: dec(item.stoneDetail.wholesalePricePerCt),
        costPerCt: dec(item.stoneDetail.costPerCt),
        ratio: dec(item.stoneDetail.ratio),
        totalWholesalePrice: dec(item.stoneDetail.totalWholesalePrice),
        totalCost: dec(item.stoneDetail.totalCost),
        photo1Url: item.stoneDetail.photo1Url,
        photo2Url: item.stoneDetail.photo2Url,
        videoUrl: item.stoneDetail.videoUrl
      }
    : null;

  const jewelry: JewelryDetailInput | null = item.jewelryDetail
    ? {
        brand: item.jewelryDetail.brand,
        jewelryItemType: item.jewelryDetail.jewelryItemType,
        metal: item.jewelryDetail.metal,
        ringSize: item.jewelryDetail.ringSize,
        lengthMm: dec(item.jewelryDetail.lengthMm),
        productionCost: dec(item.jewelryDetail.productionCost),
        wholesalePrice: dec(item.jewelryDetail.wholesalePrice),
        retailPrice: dec(item.jewelryDetail.retailPrice),
        description: item.jewelryDetail.description,
        certNumber: item.jewelryDetail.certNumber
      }
    : null;

  const other: OtherMaterialDetailInput | null = item.otherMaterialDetail
    ? {
        subtype: item.otherMaterialDetail.subtype,
        metalType: item.otherMaterialDetail.metalType,
        lengthMm: dec(item.otherMaterialDetail.lengthMm),
        widthMm: dec(item.otherMaterialDetail.widthMm),
        weightGrams: dec(item.otherMaterialDetail.weightGrams),
        quantity: item.otherMaterialDetail.quantity,
        description: item.otherMaterialDetail.description,
        cost: dec(item.otherMaterialDetail.cost)
      }
    : null;

  const statusHistory: ItemStatusHistoryRow[] = item.statusHistory.map((h) => ({
    id: h.id,
    previousStatus: h.previousStatus,
    newStatus: h.newStatus,
    documentId: h.documentId,
    changedByName: h.changedBy?.fullName ?? null,
    changedAt: h.changedAt.toISOString(),
    notes: h.notes
  }));

  const documents: LinkedDocumentRow[] = item.lineItems.map((li) => ({
    id: li.document.id,
    type: li.document.type,
    documentNumber: li.document.documentNumber,
    externalReference: li.document.externalReference,
    status: li.document.status,
    lineStatus: li.lineStatus,
    issueDate: li.document.issueDate.toISOString()
  }));

  return {
    id: item.id,
    sku: item.sku,
    itemType: item.itemType,
    itemSubtype: item.itemSubtype,
    status: item.status,
    visibleOnPortal: item.visibleOnPortal,
    vendorId: item.vendorId,
    vendorName: item.vendor?.name ?? null,
    brandOwnerId: item.brandOwnerId,
    brandOwnerName: item.brandOwner?.name ?? null,
    reservedForClientId: item.reservedForClientId,
    reservedForClientName: item.reservedForClient?.name ?? null,
    reservedAt: item.reservedAt?.toISOString() ?? null,
    notes: item.notes,
    enteredStockAt: item.enteredStockAt.toISOString(),
    daysInStock: daysInStock(item.enteredStockAt),
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    stone,
    jewelry,
    other,
    statusHistory,
    documents
  };
}

// Query-bag parser for the list endpoint (Express req.query → typed params).
type QueryValue = string | string[] | undefined;

function one(v: QueryValue): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  const t = s?.trim();
  return t ? t : undefined;
}

export function parseInventoryListParams(q: Record<string, QueryValue>): InventoryListParams {
  const num = (v: QueryValue, fallback: number): number => {
    const n = Number(one(v));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  const SORTS = [
    "newest",
    "oldest",
    "sku-asc",
    "sku-desc",
    "price-asc",
    "price-desc",
    "days-in-stock-desc",
    "days-in-stock-asc"
  ];
  const STATUSES = ["IN_STOCK", "RESERVED", "ON_MEMO", "ON_CONSIGNMENT", "SOLD", "RETURNED"];
  const ITEM_TYPES = ["STONE", "JEWELRY", "OTHER_MATERIAL"];
  const sortRaw = one(q.sort);
  const visRaw = one(q.visibleOnPortal);
  const mediaRaw = one(q.media);
  const statusRaw = one(q.status);
  const itemTypeRaw = one(q.itemType);

  return {
    query: one(q.q),
    status: (STATUSES.includes(statusRaw ?? "")
      ? statusRaw
      : undefined) as InventoryListParams["status"],
    itemType: (ITEM_TYPES.includes(itemTypeRaw ?? "")
      ? itemTypeRaw
      : undefined) as InventoryListParams["itemType"],
    vendorId: one(q.vendorId),
    brandOwnerId: one(q.brandOwnerId),
    visibleOnPortal: visRaw === undefined ? undefined : visRaw === "true",
    media:
      mediaRaw === "with" || mediaRaw === "without"
        ? (mediaRaw as InventoryListParams["media"])
        : undefined,
    sort: (SORTS.includes(sortRaw ?? "") ? sortRaw : "newest") as InventoryListParams["sort"],
    page: num(q.page, 1),
    perPage: num(q.perPage, 50)
  };
}
