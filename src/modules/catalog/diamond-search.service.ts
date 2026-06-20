import { Prisma, prisma } from "@/db";
import { resolveStillImageUrl, sanitizeMediaUrl } from "@/domain";
import type {
  DiamondCard,
  DiamondFilterBounds,
  DiamondOrigin,
  DiamondSearchFilters,
  DiamondSearchParams,
  DiamondSearchResult,
  DiamondSortKey
} from "@/contract";

const DEFAULT_PER_PAGE = 50;

// Only the columns the DiamondCard mapping below actually reads. Critically this
// EXCLUDES `rawFeedRow` (the full raw-feed JSON blob stored per row) and other
// unused columns, so list queries don't drag the heaviest data off disk on every
// page — keeps Disk IO down on the small Supabase compute. Keep in sync with the
// `rows.map(...)` projection.
const DIAMOND_CARD_SELECT = {
  id: true,
  sku: true,
  vendor: true,
  origin: true,
  shapeMapped: true,
  shapeRaw: true,
  weightCt: true,
  colorWhite: true,
  fancyColor: true,
  clarity: true,
  cutGrade: true,
  lengthMm: true,
  widthMm: true,
  ratio: true,
  basePriceUsd: true,
  basePricePerCtUsd: true,
  certLab: true,
  certNumber: true,
  certUrl: true,
  photoUrl: true,
  videoUrl: true
} satisfies Prisma.DiamondSelect;

function dec(n: number) {
  return new Prisma.Decimal(n);
}

function toNumber(value: Prisma.Decimal | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function buildWhere(
  origin: DiamondOrigin,
  filters: DiamondSearchFilters,
  query: string | undefined
): Prisma.DiamondWhereInput {
  const where: Prisma.DiamondWhereInput = { isAvailable: true, origin };
  const and: Prisma.DiamondWhereInput[] = [];

  const shapes = filters.shape?.filter(Boolean) ?? [];
  if (shapes.length) {
    and.push({
      OR: shapes.map((s) => ({ shapeMapped: { equals: s, mode: "insensitive" as const } }))
    });
  }
  const colors = filters.color?.filter(Boolean) ?? [];
  if (colors.length) {
    and.push({
      OR: colors.map((c) => ({ colorWhite: { equals: c, mode: "insensitive" as const } }))
    });
  }
  const fancies = filters.fancyColor?.filter(Boolean) ?? [];
  if (fancies.length) {
    and.push({
      OR: fancies.map((c) => ({ fancyColor: { contains: c, mode: "insensitive" as const } }))
    });
  }
  const clarities = filters.clarity?.filter(Boolean) ?? [];
  if (clarities.length) {
    and.push({
      OR: clarities.map((c) => ({ clarity: { equals: c, mode: "insensitive" as const } }))
    });
  }
  const cuts = filters.cut?.filter(Boolean) ?? [];
  if (cuts.length) {
    and.push({
      OR: cuts.map((c) => ({ cutGrade: { contains: c, mode: "insensitive" as const } }))
    });
  }
  const polishes = filters.polish?.filter(Boolean) ?? [];
  if (polishes.length) {
    and.push({
      OR: polishes.map((c) => ({ polish: { contains: c, mode: "insensitive" as const } }))
    });
  }
  const symmetries = filters.symmetry?.filter(Boolean) ?? [];
  if (symmetries.length) {
    and.push({
      OR: symmetries.map((c) => ({ symmetry: { contains: c, mode: "insensitive" as const } }))
    });
  }
  const labs = filters.lab?.filter(Boolean) ?? [];
  if (labs.length) {
    and.push({
      OR: labs.map((c) => ({ certLab: { equals: c, mode: "insensitive" as const } }))
    });
  }

  const weight: Prisma.DecimalFilter = {};
  if (typeof filters.caratMin === "number") weight.gte = dec(filters.caratMin);
  if (typeof filters.caratMax === "number") weight.lte = dec(filters.caratMax);
  if (Object.keys(weight).length) and.push({ weightCt: weight });

  const ratio: Prisma.DecimalFilter = {};
  if (typeof filters.ratioMin === "number") ratio.gte = dec(filters.ratioMin);
  if (typeof filters.ratioMax === "number") ratio.lte = dec(filters.ratioMax);
  if (Object.keys(ratio).length) and.push({ ratio });

  const lengthMm: Prisma.DecimalFilter = {};
  if (typeof filters.lengthMin === "number") lengthMm.gte = dec(filters.lengthMin);
  if (typeof filters.lengthMax === "number") lengthMm.lte = dec(filters.lengthMax);
  if (Object.keys(lengthMm).length) and.push({ lengthMm });

  const widthMm: Prisma.DecimalFilter = {};
  if (typeof filters.widthMin === "number") widthMm.gte = dec(filters.widthMin);
  if (typeof filters.widthMax === "number") widthMm.lte = dec(filters.widthMax);
  if (Object.keys(widthMm).length) and.push({ widthMm });

  if (query) {
    and.push({
      OR: [
        { sku: { contains: query, mode: "insensitive" } },
        { shapeRaw: { contains: query, mode: "insensitive" } },
        { colorWhite: { contains: query, mode: "insensitive" } },
        { fancyColor: { contains: query, mode: "insensitive" } },
        { certNumber: { contains: query, mode: "insensitive" } }
      ]
    });
  }

  if (and.length) where.AND = and;
  return where;
}

function buildOrderBy(
  sort: DiamondSortKey
): Prisma.DiamondOrderByWithRelationInput | Prisma.DiamondOrderByWithRelationInput[] {
  switch (sort) {
    case "price-asc":
      return { basePriceUsd: { sort: "asc", nulls: "last" } };
    case "price-desc":
      return { basePriceUsd: { sort: "desc", nulls: "last" } };
    case "weight-asc":
      return { weightCt: { sort: "asc", nulls: "last" } };
    case "weight-desc":
      return { weightCt: { sort: "desc", nulls: "last" } };
    case "clarity-desc":
      return [{ clarityRank: { sort: "desc", nulls: "last" } }, { sku: "asc" }];
    case "clarity-asc":
      return [{ clarityRank: { sort: "asc", nulls: "last" } }, { sku: "asc" }];
    case "ratio-asc":
      return [{ ratio: { sort: "asc", nulls: "last" } }, { sku: "asc" }];
    case "ratio-desc":
      return [{ ratio: { sort: "desc", nulls: "last" } }, { sku: "asc" }];
    case "newest":
    default:
      return [{ feedRowIndex: { sort: "asc", nulls: "last" } }, { sku: "asc" }];
  }
}

function applyPriceFilter(
  where: Prisma.DiamondWhereInput,
  filters: DiamondSearchFilters,
  factor: number
): void {
  if (typeof filters.priceMin !== "number" && typeof filters.priceMax !== "number") return;
  const priceCondition: Prisma.DecimalFilter = {};
  if (typeof filters.priceMin === "number") priceCondition.gte = dec(filters.priceMin / factor);
  if (typeof filters.priceMax === "number") priceCondition.lte = dec(filters.priceMax / factor);
  const andList = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
  where.AND = [...andList, { basePriceUsd: priceCondition }];
}

async function getMarkupPct(
  origin: DiamondOrigin,
  companyId: string | null
): Promise<number> {
  if (!companyId) return 0;
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { labDiamondMarkupPct: true, naturalDiamondMarkupPct: true }
  });
  const raw = origin === "Lab"
    ? company?.labDiamondMarkupPct
    : company?.naturalDiamondMarkupPct;
  const n = Number(raw ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export async function searchDiamonds(
  params: DiamondSearchParams,
  origin: DiamondOrigin,
  companyId: string | null
): Promise<DiamondSearchResult> {
  const perPage = Math.max(1, Math.min(100, params.perPage || DEFAULT_PER_PAGE));
  const page = Math.max(1, params.page || 1);

  const markupPct = await getMarkupPct(origin, companyId);
  const factor = 1 + markupPct / 100;

  const where = buildWhere(origin, params.filters, params.query?.trim() || undefined);
  applyPriceFilter(where, params.filters, factor);

  const [total, rows] = await Promise.all([
    prisma.diamond.count({ where }),
    prisma.diamond.findMany({
      where,
      orderBy: buildOrderBy(params.sort),
      skip: (page - 1) * perPage,
      take: perPage,
      select: DIAMOND_CARD_SELECT
    })
  ]);

  const items: DiamondCard[] = rows.map((d) => {
    const base = toNumber(d.basePriceUsd);
    const basePerCt = toNumber(d.basePricePerCtUsd);
    return {
      id: d.id,
      sku: d.sku,
      vendor: d.vendor,
      origin: d.origin as DiamondOrigin,
      shape: d.shapeMapped ?? d.shapeRaw,
      weightCt: toNumber(d.weightCt),
      color: d.colorWhite,
      fancyColor: d.fancyColor,
      clarity: d.clarity,
      cutGrade: d.cutGrade,
      lengthMm: toNumber(d.lengthMm),
      widthMm: toNumber(d.widthMm),
      ratio: toNumber(d.ratio),
      displayPriceUsd: base === null ? null : Math.round(base * factor * 100) / 100,
      displayPricePerCtUsd:
        basePerCt === null ? null : Math.round(basePerCt * factor * 100) / 100,
      certLab: d.certLab,
      certNumber: d.certNumber,
      certUrl: d.certUrl,
      photoUrl: resolveStillImageUrl(d.photoUrl, d.videoUrl),
      videoUrl: sanitizeMediaUrl(d.videoUrl, "video")
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

export async function countDiamonds(
  filters: DiamondSearchFilters,
  origin: DiamondOrigin,
  companyId: string | null,
  query?: string
): Promise<number> {
  const markupPct = await getMarkupPct(origin, companyId);
  const factor = 1 + markupPct / 100;
  const where = buildWhere(origin, filters, query?.trim() || undefined);
  applyPriceFilter(where, filters, factor);
  return prisma.diamond.count({ where });
}

const DEFAULT_BOUNDS: DiamondFilterBounds = {
  caratMin: 0,
  caratMax: 10,
  priceMin: 0,
  priceMax: 50000
};

export async function getDiamondFilterBounds(
  origin: DiamondOrigin,
  companyId: string | null
): Promise<DiamondFilterBounds> {
  const markupPct = await getMarkupPct(origin, companyId);
  const factor = 1 + markupPct / 100;
  const agg = await prisma.diamond.aggregate({
    where: { isAvailable: true, origin },
    _min: { weightCt: true, basePriceUsd: true },
    _max: { weightCt: true, basePriceUsd: true }
  });
  const caratMinRaw = toNumber(agg._min.weightCt);
  const caratMaxRaw = toNumber(agg._max.weightCt);
  const priceMinRaw = toNumber(agg._min.basePriceUsd);
  const priceMaxRaw = toNumber(agg._max.basePriceUsd);

  if (caratMaxRaw === null || priceMaxRaw === null) return DEFAULT_BOUNDS;

  return {
    caratMin: Math.floor((caratMinRaw ?? 0) * 10) / 10,
    caratMax: Math.ceil((caratMaxRaw ?? DEFAULT_BOUNDS.caratMax) * 10) / 10,
    priceMin: Math.floor(((priceMinRaw ?? 0) * factor) / 100) * 100,
    priceMax: Math.ceil(((priceMaxRaw ?? DEFAULT_BOUNDS.priceMax) * factor) / 100) * 100
  };
}
