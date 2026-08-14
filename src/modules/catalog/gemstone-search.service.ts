import { Prisma, prisma } from "@/db";
import {
  GEMSTONE_VARIETY_FILTERS,
  gemstoneAbbreviationsForFilter,
  gemstoneOriginDisplay,
  gemstoneVarietyTokensForFilter,
  mapGemstoneShape,
  resolveStillImageUrl,
  sanitizeMediaUrl
} from "@/domain";
import type {
  GemstoneCard,
  GemstoneFilterBounds,
  GemstoneSearchFilters,
  GemstoneSearchParams,
  GemstoneSearchResult,
  GemstoneSortKey
} from "@/contract";

const DEFAULT_PER_PAGE = 50;

function dec(value: number) {
  return new Prisma.Decimal(value);
}

function toNumber(value: Prisma.Decimal | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function buildWhere(filters: GemstoneSearchFilters, query: string | undefined): Prisma.GemstoneWhereInput {
  const where: Prisma.GemstoneWhereInput = { isAvailable: true };
  const and: Prisma.GemstoneWhereInput[] = [];

  const varieties = filters.variety?.filter(Boolean) ?? [];
  if (varieties.length) {
    const namedConds = (name: string): Prisma.GemstoneWhereInput[] => [
      ...gemstoneVarietyTokensForFilter(name).map((t) => ({
        varietyRaw: { equals: t, mode: "insensitive" as const }
      })),
      { varietyRaw: { contains: name, mode: "insensitive" as const } }
    ];
    const orConds: Prisma.GemstoneWhereInput[] = [];
    for (const sel of varieties) {
      if (sel.toLowerCase() === "other") {
        const known = GEMSTONE_VARIETY_FILTERS.flatMap(namedConds);
        orConds.push({ NOT: { OR: known } });
      } else {
        orConds.push(...namedConds(sel));
      }
    }
    if (orConds.length) and.push({ OR: orConds });
  }
  const shapes = filters.shape?.filter(Boolean) ?? [];
  if (shapes.length) {
    const abbrevs = shapes.flatMap(gemstoneAbbreviationsForFilter);
    const conditions: Prisma.GemstoneWhereInput[] = abbrevs.map((a) => ({
      shapeRaw: { equals: a, mode: "insensitive" as const }
    }));
    shapes.forEach((s) => {
      conditions.push({ shapeRaw: { equals: s, mode: "insensitive" as const } });
    });
    if (conditions.length) {
      and.push({ OR: conditions });
    }
  }
  const colors = filters.color?.filter(Boolean) ?? [];
  if (colors.length) {
    and.push({
      OR: colors.map((c) => ({ colorRaw: { contains: c, mode: "insensitive" } }))
    });
  }
  const origins = filters.origin?.filter(Boolean) ?? [];
  if (origins.length) {
    and.push({
      OR: origins.map((o) => ({ origin: { contains: o, mode: "insensitive" } }))
    });
  }

  if (filters.certification === "certified") {
    and.push({ NOT: { certNumber: null } });
  } else if (filters.certification === "uncertified") {
    and.push({ certNumber: null });
  }

  const weight: Prisma.DecimalFilter = {};
  if (typeof filters.caratMin === "number") weight.gte = dec(filters.caratMin);
  if (typeof filters.caratMax === "number") weight.lte = dec(filters.caratMax);
  if (Object.keys(weight).length) and.push({ weightCt: weight });

  const ratio: Prisma.DecimalFilter = {};
  if (typeof filters.ratioMin === "number") ratio.gte = dec(filters.ratioMin);
  if (typeof filters.ratioMax === "number") ratio.lte = dec(filters.ratioMax);
  if (Object.keys(ratio).length) and.push({ ratio });

  const length: Prisma.DecimalFilter = {};
  if (typeof filters.lengthMin === "number") length.gte = dec(filters.lengthMin);
  if (typeof filters.lengthMax === "number") length.lte = dec(filters.lengthMax);
  if (Object.keys(length).length) and.push({ lengthMm: length });

  const width: Prisma.DecimalFilter = {};
  if (typeof filters.widthMin === "number") width.gte = dec(filters.widthMin);
  if (typeof filters.widthMax === "number") width.lte = dec(filters.widthMax);
  if (Object.keys(width).length) and.push({ widthMm: width });

  if (query) {
    and.push({
      OR: [
        { sku: { contains: query, mode: "insensitive" } },
        { varietyRaw: { contains: query, mode: "insensitive" } },
        { shapeRaw: { contains: query, mode: "insensitive" } },
        { colorRaw: { contains: query, mode: "insensitive" } },
        { origin: { contains: query, mode: "insensitive" } },
        { certNumber: { contains: query, mode: "insensitive" } }
      ]
    });
  }

  if (and.length) where.AND = and;
  return where;
}

function buildOrderBy(
  sort: GemstoneSortKey
): Prisma.GemstoneOrderByWithRelationInput | Prisma.GemstoneOrderByWithRelationInput[] {
  switch (sort) {
    case "price-asc":
      return { basePriceUsd: { sort: "asc", nulls: "last" } };
    case "price-desc":
      return { basePriceUsd: { sort: "desc", nulls: "last" } };
    case "weight-asc":
      return { weightCt: { sort: "asc", nulls: "last" } };
    case "weight-desc":
      return { weightCt: { sort: "desc", nulls: "last" } };
    case "ratio-asc":
      return [{ ratio: { sort: "asc", nulls: "last" } }, { sku: "asc" }];
    case "ratio-desc":
      return [{ ratio: { sort: "desc", nulls: "last" } }, { sku: "asc" }];
    case "newest":
    default:
      return [{ feedRowIndex: { sort: "asc", nulls: "last" } }, { sku: "asc" }];
  }
}

async function getGemstoneMarkupFactor(companyId: string | null): Promise<number> {
  if (!companyId) return 1;
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { gemstoneMarkupPct: true }
  });
  let markupPct = Number(company?.gemstoneMarkupPct ?? 0);
  if (!Number.isFinite(markupPct)) markupPct = 0;
  return 1 + markupPct / 100;
}

function applyGemstonePriceFilter(
  where: Prisma.GemstoneWhereInput,
  filters: GemstoneSearchFilters,
  factor: number
): void {
  if (typeof filters.priceMin !== "number" && typeof filters.priceMax !== "number") return;
  const priceCondition: Prisma.DecimalFilter = {};
  if (typeof filters.priceMin === "number") priceCondition.gte = dec(filters.priceMin / factor);
  if (typeof filters.priceMax === "number") priceCondition.lte = dec(filters.priceMax / factor);
  const andList = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
  where.AND = [...andList, { basePriceUsd: priceCondition }];
}

const GEMSTONE_CARD_SELECT = {
  id: true,
  sku: true,
  varietyRaw: true,
  shapeRaw: true,
  colorRaw: true,
  weightCt: true,
  lengthMm: true,
  widthMm: true,
  ratio: true,
  basePriceUsd: true,
  basePricePerCtUsd: true,
  certLab: true,
  certNumber: true,
  imageUrl: true,
  videoUrl: true,
  origin: true
} satisfies Prisma.GemstoneSelect;

export async function searchGemstones(
  params: GemstoneSearchParams,
  companyId: string | null
): Promise<GemstoneSearchResult> {
  const perPage = Math.max(1, Math.min(100, params.perPage || DEFAULT_PER_PAGE));
  const page = Math.max(1, params.page || 1);

  const factor = await getGemstoneMarkupFactor(companyId);

  const where = buildWhere(params.filters, params.query?.trim() || undefined);
  applyGemstonePriceFilter(where, params.filters, factor);

  const [total, rows] = await Promise.all([
    prisma.gemstone.count({ where }),
    prisma.gemstone.findMany({
      where,
      orderBy: buildOrderBy(params.sort),
      skip: (page - 1) * perPage,
      take: perPage,
      select: GEMSTONE_CARD_SELECT
    })
  ]);

  const items: GemstoneCard[] = rows.map((g) => {
    const base = toNumber(g.basePriceUsd);
    const basePerCt = toNumber(g.basePricePerCtUsd);
    return {
      id: g.id,
      sku: g.sku,
      varietyRaw: g.varietyRaw,
      shapeRaw: g.shapeRaw,
      shapeMapped: mapGemstoneShape(g.shapeRaw)?.display ?? g.shapeRaw,
      colorRaw: g.colorRaw,
      weightCt: toNumber(g.weightCt),
      lengthMm: toNumber(g.lengthMm),
      widthMm: toNumber(g.widthMm),
      ratio: toNumber(g.ratio),
      displayPriceUsd: base === null ? null : Math.round(base * factor * 100) / 100,
      displayPricePerCtUsd:
        basePerCt === null ? null : Math.round(basePerCt * factor * 100) / 100,
      certLab: g.certLab,
      certNumber: g.certNumber,
      imageUrl: resolveStillImageUrl(g.imageUrl, g.videoUrl),
      videoUrl: sanitizeMediaUrl(g.videoUrl, "video"),
      origin: gemstoneOriginDisplay(g.origin)
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

export async function countGemstones(
  filters: GemstoneSearchFilters,
  companyId: string | null,
  query?: string
): Promise<number> {
  const factor = await getGemstoneMarkupFactor(companyId);
  const where = buildWhere(filters, query?.trim() || undefined);
  applyGemstonePriceFilter(where, filters, factor);
  return prisma.gemstone.count({ where });
}

const DEFAULT_GEMSTONE_BOUNDS: GemstoneFilterBounds = {
  caratMin: 0,
  caratMax: 20,
  priceMin: 0,
  priceMax: 50000
};

export async function getGemstoneFilterBounds(
  companyId: string | null
): Promise<GemstoneFilterBounds> {
  const factor = await getGemstoneMarkupFactor(companyId);
  const agg = await prisma.gemstone.aggregate({
    where: { isAvailable: true },
    _min: { weightCt: true, basePriceUsd: true },
    _max: { weightCt: true, basePriceUsd: true }
  });
  const caratMaxRaw = toNumber(agg._max.weightCt);
  const priceMaxRaw = toNumber(agg._max.basePriceUsd);
  if (caratMaxRaw === null || priceMaxRaw === null) return DEFAULT_GEMSTONE_BOUNDS;

  const caratMinRaw = toNumber(agg._min.weightCt);
  const priceMinRaw = toNumber(agg._min.basePriceUsd);
  return {
    caratMin: Math.floor((caratMinRaw ?? 0) * 10) / 10,
    caratMax: Math.ceil(caratMaxRaw * 10) / 10,
    priceMin: Math.floor(((priceMinRaw ?? 0) * factor) / 100) * 100,
    priceMax: Math.ceil((priceMaxRaw * factor) / 100) * 100
  };
}
