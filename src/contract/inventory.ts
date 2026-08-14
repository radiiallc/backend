import { z } from "zod";

export const DiamondOriginSchema = z.enum(["Lab", "Natural"]);
export type DiamondOrigin = z.infer<typeof DiamondOriginSchema>;

export const DIAMOND_SORT_KEYS = [
  "newest",
  "price-asc",
  "price-desc",
  "weight-asc",
  "weight-desc",
  "clarity-asc",
  "clarity-desc",
  "ratio-asc",
  "ratio-desc"
] as const;

export type DiamondSortKey = (typeof DIAMOND_SORT_KEYS)[number];

export type DiamondSearchFilters = {
  shape?: string[];
  color?: string[];
  fancyColor?: string[];
  clarity?: string[];
  cut?: string[];
  polish?: string[];
  symmetry?: string[];
  lab?: string[];
  caratMin?: number;
  caratMax?: number;
  ratioMin?: number;
  ratioMax?: number;
  lengthMin?: number;
  lengthMax?: number;
  widthMin?: number;
  widthMax?: number;
  priceMin?: number;
  priceMax?: number;
};

export type DiamondSearchParams = {
  filters: DiamondSearchFilters;
  sort: DiamondSortKey;
  page: number;
  perPage: number;
  query?: string;
};

export const DiamondCardSchema = z.object({
  id: z.string(),
  sku: z.string(),
  vendor: z.string(),
  origin: DiamondOriginSchema,
  shape: z.string().nullable(),
  weightCt: z.number().nullable(),
  color: z.string().nullable(),
  fancyColor: z.string().nullable(),
  clarity: z.string().nullable(),
  cutGrade: z.string().nullable(),
  lengthMm: z.number().nullable(),
  widthMm: z.number().nullable(),
  ratio: z.number().nullable(),
  displayPriceUsd: z.number().nullable(),
  displayPricePerCtUsd: z.number().nullable(),
  certLab: z.string().nullable(),
  certNumber: z.string().nullable(),
  certUrl: z.string().nullable(),
  photoUrl: z.string().nullable(),
  videoUrl: z.string().nullable()
});
export type DiamondCard = z.infer<typeof DiamondCardSchema>;

export const DiamondDetailSchema = z.object({
  id: z.string(),
  sku: z.string(),
  origin: DiamondOriginSchema,
  shapeRaw: z.string().nullable(),
  shapeMapped: z.string().nullable(),
  weightCt: z.number().nullable(),
  colorWhite: z.string().nullable(),
  fancyColor: z.string().nullable(),
  clarity: z.string().nullable(),
  cutGrade: z.string().nullable(),
  polish: z.string().nullable(),
  symmetry: z.string().nullable(),
  fluorescence: z.string().nullable(),
  lengthMm: z.number().nullable(),
  widthMm: z.number().nullable(),
  depthMm: z.number().nullable(),
  ratio: z.number().nullable(),
  depthPct: z.number().nullable(),
  tablePct: z.number().nullable(),
  certLab: z.string().nullable(),
  certNumber: z.string().nullable(),
  certUrl: z.string().nullable(),
  treatment: z.string().nullable(),
  growthMethod: z.string().nullable(),
  displayPriceUsd: z.number().nullable(),
  displayPricePerCtUsd: z.number().nullable(),
  videoUrl: z.string().nullable(),
  photoUrl: z.string().nullable(),
  isAvailable: z.boolean()
});
export type DiamondDetail = z.infer<typeof DiamondDetailSchema>;

export const DiamondSearchResultSchema = z.object({
  items: z.array(DiamondCardSchema),
  total: z.number(),
  page: z.number(),
  perPage: z.number(),
  totalPages: z.number()
});
export type DiamondSearchResult = z.infer<typeof DiamondSearchResultSchema>;

export const DiamondFilterBoundsSchema = z.object({
  caratMin: z.number(),
  caratMax: z.number(),
  priceMin: z.number(),
  priceMax: z.number()
});
export type DiamondFilterBounds = z.infer<typeof DiamondFilterBoundsSchema>;

export const GEMSTONE_SORT_KEYS = [
  "newest",
  "price-asc",
  "price-desc",
  "weight-asc",
  "weight-desc",
  "ratio-asc",
  "ratio-desc"
] as const;

export type GemstoneSortKey = (typeof GEMSTONE_SORT_KEYS)[number];

export const GEMSTONE_CERTIFICATION_VALUES = ["all", "certified", "uncertified"] as const;
export type GemstoneCertification = (typeof GEMSTONE_CERTIFICATION_VALUES)[number];

export type GemstoneSearchFilters = {
  variety?: string[];
  shape?: string[];
  color?: string[];
  origin?: string[];
  certification?: GemstoneCertification;
  caratMin?: number;
  caratMax?: number;
  ratioMin?: number;
  ratioMax?: number;
  lengthMin?: number;
  lengthMax?: number;
  widthMin?: number;
  widthMax?: number;
  priceMin?: number;
  priceMax?: number;
};

export type GemstoneSearchParams = {
  filters: GemstoneSearchFilters;
  sort: GemstoneSortKey;
  page: number;
  perPage: number;
  query?: string;
};

export const GemstoneCardSchema = z.object({
  id: z.string(),
  sku: z.string(),
  varietyRaw: z.string().nullable(),
  shapeRaw: z.string().nullable(),
  shapeMapped: z.string().nullable(),
  colorRaw: z.string().nullable(),
  weightCt: z.number().nullable(),
  lengthMm: z.number().nullable(),
  widthMm: z.number().nullable(),
  ratio: z.number().nullable(),
  displayPriceUsd: z.number().nullable(),
  displayPricePerCtUsd: z.number().nullable(),
  certLab: z.string().nullable(),
  certNumber: z.string().nullable(),
  imageUrl: z.string().nullable(),
  videoUrl: z.string().nullable(),
  origin: z.string().nullable()
});
export type GemstoneCard = z.infer<typeof GemstoneCardSchema>;

export const GemstoneDetailSchema = z.object({
  id: z.string(),
  sku: z.string(),
  varietyRaw: z.string().nullable(),
  varietyMapped: z.string().nullable(),
  shapeRaw: z.string().nullable(),
  shapeMapped: z.string().nullable(),
  colorRaw: z.string().nullable(),
  weightCt: z.number().nullable(),
  lengthMm: z.number().nullable(),
  widthMm: z.number().nullable(),
  depthMm: z.number().nullable(),
  ratio: z.number().nullable(),
  displayPriceUsd: z.number().nullable(),
  displayPricePerCtUsd: z.number().nullable(),
  certLab: z.string().nullable(),
  certNumber: z.string().nullable(),
  certUrl: z.string().nullable(),
  imageUrl: z.string().nullable(),
  image2Url: z.string().nullable(),
  image3Url: z.string().nullable(),
  image4Url: z.string().nullable(),
  videoUrl: z.string().nullable(),
  origin: z.string().nullable(),
  treatment: z.string().nullable(),
  isAvailable: z.boolean()
});
export type GemstoneDetail = z.infer<typeof GemstoneDetailSchema>;

export const GemstoneSearchResultSchema = z.object({
  items: z.array(GemstoneCardSchema),
  total: z.number(),
  page: z.number(),
  perPage: z.number(),
  totalPages: z.number()
});
export type GemstoneSearchResult = z.infer<typeof GemstoneSearchResultSchema>;

export const GemstoneFilterBoundsSchema = z.object({
  caratMin: z.number(),
  caratMax: z.number(),
  priceMin: z.number(),
  priceMax: z.number()
});
export type GemstoneFilterBounds = z.infer<typeof GemstoneFilterBoundsSchema>;

export const InventoryCountsSchema = z.object({
  natural: z.number(),
  lab: z.number(),
  gemstones: z.number()
});
export type InventoryCounts = z.infer<typeof InventoryCountsSchema>;

type QueryValue = string | string[] | undefined;
type QueryBag = Record<string, QueryValue>;

function readString(value: QueryValue): string | undefined {
  if (Array.isArray(value)) return value[0]?.trim() || undefined;
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readStringList(value: QueryValue): string[] | undefined {
  const raws: string[] = [];
  const push = (s: string | undefined) => {
    if (!s) return;
    for (const part of s.split(",")) {
      const t = part.trim();
      if (t) raws.push(t);
    }
  };
  if (Array.isArray(value)) value.forEach(push);
  else push(value);
  const unique = Array.from(new Set(raws));
  return unique.length ? unique : undefined;
}

function readNumber(value: QueryValue): number | undefined {
  const raw = readString(value);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function readDiamondSort(value: QueryValue): DiamondSortKey {
  const raw = readString(value);
  return (DIAMOND_SORT_KEYS as readonly string[]).includes(raw ?? "")
    ? (raw as DiamondSortKey)
    : "weight-asc";
}

export function parseDiamondSearchParams(sp: QueryBag): DiamondSearchParams {
  const filters: DiamondSearchFilters = {
    shape: readStringList(sp.shape),
    color: readStringList(sp.color),
    fancyColor: readStringList(sp.fancyColor),
    clarity: readStringList(sp.clarity),
    cut: readStringList(sp.cut),
    polish: readStringList(sp.polish),
    symmetry: readStringList(sp.symmetry),
    lab: readStringList(sp.lab),
    caratMin: readNumber(sp.caratMin),
    caratMax: readNumber(sp.caratMax),
    ratioMin: readNumber(sp.ratioMin),
    ratioMax: readNumber(sp.ratioMax),
    lengthMin: readNumber(sp.lengthMin),
    lengthMax: readNumber(sp.lengthMax),
    widthMin: readNumber(sp.widthMin),
    widthMax: readNumber(sp.widthMax),
    priceMin: readNumber(sp.priceMin),
    priceMax: readNumber(sp.priceMax)
  };

  return {
    filters,
    sort: readDiamondSort(sp.sort),
    page: readNumber(sp.page) ?? 1,
    perPage: readNumber(sp.perPage) ?? 50,
    query: readString(sp.q)
  };
}

export function diamondSearchParamsToQuery(params: DiamondSearchParams): URLSearchParams {
  const q = new URLSearchParams();
  const { filters } = params;
  if (filters.shape?.length) q.set("shape", filters.shape.join(","));
  if (filters.color?.length) q.set("color", filters.color.join(","));
  if (filters.fancyColor?.length) q.set("fancyColor", filters.fancyColor.join(","));
  if (filters.clarity?.length) q.set("clarity", filters.clarity.join(","));
  if (filters.cut?.length) q.set("cut", filters.cut.join(","));
  if (filters.polish?.length) q.set("polish", filters.polish.join(","));
  if (filters.symmetry?.length) q.set("symmetry", filters.symmetry.join(","));
  if (filters.lab?.length) q.set("lab", filters.lab.join(","));
  if (filters.caratMin !== undefined) q.set("caratMin", String(filters.caratMin));
  if (filters.caratMax !== undefined) q.set("caratMax", String(filters.caratMax));
  if (filters.ratioMin !== undefined) q.set("ratioMin", String(filters.ratioMin));
  if (filters.ratioMax !== undefined) q.set("ratioMax", String(filters.ratioMax));
  if (filters.lengthMin !== undefined) q.set("lengthMin", String(filters.lengthMin));
  if (filters.lengthMax !== undefined) q.set("lengthMax", String(filters.lengthMax));
  if (filters.widthMin !== undefined) q.set("widthMin", String(filters.widthMin));
  if (filters.widthMax !== undefined) q.set("widthMax", String(filters.widthMax));
  if (filters.priceMin !== undefined) q.set("priceMin", String(filters.priceMin));
  if (filters.priceMax !== undefined) q.set("priceMax", String(filters.priceMax));
  if (params.sort && params.sort !== "weight-asc") q.set("sort", params.sort);
  if (params.page && params.page > 1) q.set("page", String(params.page));
  if (params.perPage && params.perPage !== 50) q.set("perPage", String(params.perPage));
  if (params.query) q.set("q", params.query);
  return q;
}

function readGemstoneSort(value: QueryValue): GemstoneSortKey {
  const raw = readString(value);
  return (GEMSTONE_SORT_KEYS as readonly string[]).includes(raw ?? "")
    ? (raw as GemstoneSortKey)
    : "weight-asc";
}

function readCertification(value: QueryValue): GemstoneCertification | undefined {
  const raw = readString(value)?.toLowerCase();
  return (GEMSTONE_CERTIFICATION_VALUES as readonly string[]).includes(raw ?? "")
    ? (raw as GemstoneCertification)
    : undefined;
}

export function parseGemstoneSearchParams(sp: QueryBag): GemstoneSearchParams {
  const filters: GemstoneSearchFilters = {
    variety: readStringList(sp.variety),
    shape: readStringList(sp.shape),
    color: readStringList(sp.color),
    origin: readStringList(sp.origin),
    certification: readCertification(sp.cert),
    caratMin: readNumber(sp.caratMin),
    caratMax: readNumber(sp.caratMax),
    ratioMin: readNumber(sp.ratioMin),
    ratioMax: readNumber(sp.ratioMax),
    lengthMin: readNumber(sp.lengthMin),
    lengthMax: readNumber(sp.lengthMax),
    widthMin: readNumber(sp.widthMin),
    widthMax: readNumber(sp.widthMax),
    priceMin: readNumber(sp.priceMin),
    priceMax: readNumber(sp.priceMax)
  };

  return {
    filters,
    sort: readGemstoneSort(sp.sort),
    page: readNumber(sp.page) ?? 1,
    perPage: readNumber(sp.perPage) ?? 50,
    query: readString(sp.q)
  };
}

export function gemstoneSearchParamsToQuery(params: GemstoneSearchParams): URLSearchParams {
  const q = new URLSearchParams();
  const { filters } = params;
  if (filters.variety && filters.variety.length) q.set("variety", filters.variety.join(","));
  if (filters.shape && filters.shape.length) q.set("shape", filters.shape.join(","));
  if (filters.color && filters.color.length) q.set("color", filters.color.join(","));
  if (filters.origin && filters.origin.length) q.set("origin", filters.origin.join(","));
  if (filters.certification) q.set("cert", filters.certification);
  if (filters.caratMin !== undefined) q.set("caratMin", String(filters.caratMin));
  if (filters.caratMax !== undefined) q.set("caratMax", String(filters.caratMax));
  if (filters.ratioMin !== undefined) q.set("ratioMin", String(filters.ratioMin));
  if (filters.ratioMax !== undefined) q.set("ratioMax", String(filters.ratioMax));
  if (filters.lengthMin !== undefined) q.set("lengthMin", String(filters.lengthMin));
  if (filters.lengthMax !== undefined) q.set("lengthMax", String(filters.lengthMax));
  if (filters.widthMin !== undefined) q.set("widthMin", String(filters.widthMin));
  if (filters.widthMax !== undefined) q.set("widthMax", String(filters.widthMax));
  if (filters.priceMin !== undefined) q.set("priceMin", String(filters.priceMin));
  if (filters.priceMax !== undefined) q.set("priceMax", String(filters.priceMax));
  if (params.sort && params.sort !== "weight-asc") q.set("sort", params.sort);
  if (params.page && params.page > 1) q.set("page", String(params.page));
  if (params.perPage && params.perPage !== 50) q.set("perPage", String(params.perPage));
  if (params.query) q.set("q", params.query);
  return q;
}
