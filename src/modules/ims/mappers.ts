import { Prisma } from "@/db";
import type {
  JewelryDetail as PrismaJewelryDetail,
  OtherMaterialDetail as PrismaOtherMaterialDetail,
  StoneDetail as PrismaStoneDetail,
  VocabularyValue as PrismaVocabularyValue
} from "@/db";
import type {
  ImsClient,
  ImsInventoryItem,
  ImsJewelryDetail,
  ImsOtherMaterialDetail,
  ImsStoneDetail,
  ImsVendor,
  ImsVocabularyValue
} from "@/contract";

// The relation set every inventory DTO needs. Exported so reads.ts and the
// mapper agree on the exact payload shape (parties for display names, all three
// detail tables, exactly one of which is non-null per itemType).
export const IMS_ITEM_INCLUDE = {
  vendor: { select: { name: true } },
  brandOwner: { select: { name: true } },
  reservedForClient: { select: { name: true } },
  stone: true,
  jewelry: true,
  material: true
} satisfies Prisma.InventoryItemInclude;

type PrismaItemWithRelations = Prisma.InventoryItemGetPayload<{
  include: typeof IMS_ITEM_INCLUDE;
}>;

// Vendors carry a derived inventory count via _count.
export const IMS_VENDOR_INCLUDE = {
  _count: { select: { inventoryItems: true } }
} satisfies Prisma.VendorInclude;

type PrismaVendorWithCount = Prisma.VendorGetPayload<{ include: typeof IMS_VENDOR_INCLUDE }>;

// Prisma Decimal | null → number | null (the wire carries plain numbers).
function decOrNull(value: Prisma.Decimal | null): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value.toString());
  return Number.isFinite(n) ? n : null;
}

function prismaStoneToDetail(s: PrismaStoneDetail): ImsStoneDetail {
  return {
    gemType: s.gemType,
    naturalOrLab: s.naturalOrLab,
    shape: s.shape,
    weightCt: decOrNull(s.weightCt),
    quantity: s.quantity,
    color: s.color,
    fancyColor: s.fancyColor,
    fancyIntensity: s.fancyIntensity,
    fancyOvertone: s.fancyOvertone,
    clarity: s.clarity,
    cutGrade: s.cutGrade,
    polish: s.polish,
    symmetry: s.symmetry,
    fluorescence: s.fluorescence,
    lengthMm: decOrNull(s.lengthMm),
    widthMm: decOrNull(s.widthMm),
    heightMm: decOrNull(s.heightMm),
    depthPct: decOrNull(s.depthPct),
    tablePct: decOrNull(s.tablePct),
    girdle: s.girdle,
    ratio: decOrNull(s.ratio),
    lab: s.lab,
    certNumber: s.certNumber,
    // certUrl is server-read-only: expose only its presence, never the URL.
    hasCert: Boolean(s.certUrl),
    origin: s.origin,
    treatment: s.treatment,
    costPerCt: decOrNull(s.costPerCt),
    wholesalePricePerCt: decOrNull(s.wholesalePricePerCt),
    totalCost: decOrNull(s.totalCost),
    totalWholesalePrice: decOrNull(s.totalWholesalePrice),
    photo1Url: s.photo1Url,
    photo2Url: s.photo2Url,
    videoUrl: s.videoUrl
  };
}

function prismaJewelryToDetail(j: PrismaJewelryDetail): ImsJewelryDetail {
  return {
    jewelryItemType: j.jewelryItemType,
    description: j.description,
    quantity: j.quantity,
    metal: j.metal,
    lengthMm: decOrNull(j.lengthMm),
    ringSize: j.ringSize,
    mm: decOrNull(j.mm),
    metalWeightGrams: decOrNull(j.metalWeightGrams),
    productionCost: decOrNull(j.productionCost),
    wholesalePrice: decOrNull(j.wholesalePrice),
    retailPrice: decOrNull(j.retailPrice),
    brand: j.brand,
    certNumber: j.certNumber,
    photo1Url: j.photo1Url,
    photo2Url: j.photo2Url,
    videoUrl: j.videoUrl
  };
}

function prismaOtherToDetail(m: PrismaOtherMaterialDetail): ImsOtherMaterialDetail {
  return {
    category: m.category,
    subtype: m.subtype,
    quantity: m.quantity,
    metalType: m.metalType,
    lengthMm: decOrNull(m.lengthMm),
    size: m.size,
    mm: decOrNull(m.mm),
    weightGrams: decOrNull(m.weightGrams),
    description: m.description,
    cost: decOrNull(m.cost),
    wholesalePrice: decOrNull(m.wholesalePrice),
    photo1Url: m.photo1Url,
    photo2Url: m.photo2Url,
    videoUrl: m.videoUrl
  };
}

// The three detail tables all carry photo1/photo2/video; the media summary is
// derived from whichever detail row is present.
function mediaSummary(
  detail: { photo1Url: string | null; photo2Url: string | null; videoUrl: string | null } | null
): { photoCount: number; hasVideo: boolean } {
  if (!detail) return { photoCount: 0, hasVideo: false };
  const photoCount = (detail.photo1Url ? 1 : 0) + (detail.photo2Url ? 1 : 0);
  return { photoCount, hasVideo: Boolean(detail.videoUrl) };
}

export function prismaItemToDto(item: PrismaItemWithRelations): ImsInventoryItem {
  const detail = item.stone ?? item.jewelry ?? item.material ?? null;
  const { photoCount, hasVideo } = mediaSummary(detail);
  return {
    id: item.id,
    sku: item.sku,
    vendorSku: item.vendorSku,
    itemName: item.itemName,
    itemType: item.itemType,
    itemSubtype: item.itemSubtype,
    status: item.status,
    vendorId: item.vendorId,
    vendorName: item.vendor?.name ?? null,
    brandOwnerId: item.brandOwnerId,
    brandOwnerName: item.brandOwner?.name ?? null,
    reservedForClientId: item.reservedForClientId,
    reservedForClientName: item.reservedForClient?.name ?? null,
    reservedAt: item.reservedAt?.toISOString() ?? null,
    visibleOnPortal: item.visibleOnPortal,
    enteredStockAt: item.enteredStockAt.toISOString(),
    notes: item.notes,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    photoCount,
    hasVideo,
    stone: item.stone ? prismaStoneToDetail(item.stone) : null,
    jewelry: item.jewelry ? prismaJewelryToDetail(item.jewelry) : null,
    material: item.material ? prismaOtherToDetail(item.material) : null
  };
}

export function prismaVendorToDto(v: PrismaVendorWithCount): ImsVendor {
  return {
    id: v.id,
    name: v.name,
    contactName: v.contactName,
    contactEmail: v.contactEmail,
    contactPhone: v.contactPhone,
    address: v.address,
    defaultMemoTermsDays: v.defaultMemoTermsDays,
    defaultInvoiceTermsDays: v.defaultInvoiceTermsDays,
    quickbooksId: v.quickbooksId,
    notes: v.notes,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
    inventoryItemCount: v._count.inventoryItems
  };
}

export function prismaVocabToDto(v: PrismaVocabularyValue): ImsVocabularyValue {
  return { id: v.id, kind: v.kind, value: v.value };
}

// ── Clients (back-office accounts) ───────────────────────────────────────────

// A client carries a derived count of open documents held against it (the
// admin's "open: N"). Filtered relation count keeps it a single query.
export const IMS_CLIENT_INCLUDE = {
  _count: { select: { clientDocuments: { where: { status: "OPEN" } } } }
} satisfies Prisma.CompanyInclude;

type PrismaClientWithCount = Prisma.CompanyGetPayload<{ include: typeof IMS_CLIENT_INCLUDE }>;

export function prismaClientToDto(c: PrismaClientWithCount): ImsClient {
  return {
    id: c.id,
    name: c.name,
    contactName: c.contactName,
    contactEmail: c.contactEmail,
    contactPhone: c.contactPhone,
    website: c.website,
    shippingAddress: c.shippingAddress,
    clientStatus: c.clientStatus,
    // Non-nullable Decimals (schema defaults 0) → plain numbers.
    creditLimitUsd: decOrNull(c.creditLimitUsd) ?? 0,
    gemstoneMarkupPct: decOrNull(c.gemstoneMarkupPct) ?? 0,
    labDiamondMarkupPct: decOrNull(c.labDiamondMarkupPct) ?? 0,
    naturalDiamondMarkupPct: decOrNull(c.naturalDiamondMarkupPct) ?? 0,
    defaultMemoTermsDays: c.defaultMemoTermsDays,
    defaultInvoiceTermsDays: c.defaultInvoiceTermsDays,
    quickbooksId: c.quickbooksId,
    internalNotes: c.internalNotes,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    openDocumentCount: c._count.clientDocuments
  };
}
