import { parse } from "csv-parse/sync";

export type FileKind = "gemstone" | "diamond";
export type DiamondVendor = "Disons" | "Skylab";
export type DiamondOrigin = "Natural" | "Lab";

export type ParsedDiamond = {
  kind: "diamond";
  feedRowId: string;
  feedRowIndex: number;
  vendor: DiamondVendor;
  origin: DiamondOrigin;
  sku: string;
  shapeRaw: string | null;
  weightCt: number | null;
  colorWhite: string | null;
  fancyColor: string | null;
  fancyIntensity: string | null;
  fancyOvertone: string | null;
  clarity: string | null;
  cutGrade: string | null;
  polish: string | null;
  symmetry: string | null;
  fluorescence: string | null;
  lengthMm: number | null;
  widthMm: number | null;
  depthMm: number | null;
  ratio: number | null;
  depthPct: number | null;
  tablePct: number | null;
  girdle: string | null;
  culet: string | null;
  certLab: string | null;
  certNumber: string | null;
  certUrl: string | null;
  treatment: string | null;
  growthMethod: string | null;
  basePricePerCtUsd: number | null;
  basePriceUsd: number | null;
  state: string | null;
  country: string | null;
  photoUrl: string | null;
  videoUrl: string | null;
  rawFeedRow: Record<string, string>;
};

export type ParsedGemstone = {
  kind: "gemstone";
  feedRowId: string;
  feedRowIndex: number;
  sku: string;
  varietyRaw: string | null;
  shapeRaw: string | null;
  colorRaw: string | null;
  weightCt: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  depthMm: number | null;
  ratio: number | null;
  basePriceUsd: number | null;
  basePricePerCtUsd: number | null;
  certLab: string | null;
  certNumber: string | null;
  certUrl: string | null;
  imageUrl: string | null;
  image2Url: string | null;
  videoUrl: string | null;
  origin: string | null;
  treatment: string | null;
  rawFeedRow: Record<string, string>;
};

export type ParsedRow = ParsedGemstone | ParsedDiamond;

export type RapNetParseSummary<T extends ParsedRow = ParsedRow> = {
  rows: T[];
  rejected: { reason: string; count: number }[];
};

export type FileTarget =
  | { kind: "diamond"; vendor: DiamondVendor; origin: DiamondOrigin }
  | { kind: "gemstone" };

const REJECT_NON_STOCK_STATUS = "non-stock-status";
const REJECT_OUT_OF_REGION = "out-of-region";
const REJECT_NO_FEED_ROW_ID = "no-feed-row-id";
const REJECT_VENDOR_MISMATCH = "vendor-mismatch";
const REJECT_PARCEL = "parcel-lot";

const ALLOWED_STATES = new Set(["NY", "CA", "LA"]);

export function detectFileTarget(filename: string): FileTarget | null {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const upper = base.toUpperCase();
  if (upper.startsWith("DISONSSTOCK")) return { kind: "diamond", vendor: "Disons", origin: "Natural" };
  if (upper.startsWith("SKYLABSTOCK")) return { kind: "diamond", vendor: "Skylab", origin: "Lab" };
  if (upper.startsWith("GEMSSTOCK")) return { kind: "gemstone" };
  return null;
}

// A "feed" is one upstream source the team monitors. `key` is the stable id used
// to persist per-feed ingest status; `label` is what the dashboard shows. The
// gemstone feed is RADIIA's own stones, hence the "RADIIA" label.
export type FeedIdentity = { key: string; label: string };

export function feedIdentityForTarget(target: FileTarget): FeedIdentity {
  if (target.kind === "gemstone") return { key: "gemstones", label: "RADIIA" };
  return { key: target.vendor.toLowerCase(), label: target.vendor };
}

export function parseRapNetCsv(csvText: string, target: FileTarget): RapNetParseSummary {
  const records = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
    trim: true
  }) as Record<string, string>[];

  const rejectCounts = new Map<string, number>();
  const tally = (reason: string) =>
    rejectCounts.set(reason, (rejectCounts.get(reason) ?? 0) + 1);

  const rows: ParsedRow[] = [];

  for (let feedRowIndex = 0; feedRowIndex < records.length; feedRowIndex++) {
    const raw = records[feedRowIndex];
    const status = (raw.Status ?? "").trim().toUpperCase();
    if (status !== "STOCK") {
      tally(REJECT_NON_STOCK_STATUS);
      continue;
    }
    if (!passesRegionFilter(raw)) {
      tally(REJECT_OUT_OF_REGION);
      continue;
    }

    // Gemstones: ingest single stones and matched pairs only — never parcels
    // (a lot of multiple loose stones sold together).
    if (target.kind === "gemstone" && isParcel(raw)) {
      tally(REJECT_PARCEL);
      continue;
    }

    if (target.kind === "diamond") {
      const seller = (raw.Seller ?? "").trim().toUpperCase();
      if (
        (target.vendor === "Disons" && seller && seller !== "DISONS") ||
        (target.vendor === "Skylab" && seller && seller !== "SKYLAB")
      ) {
        tally(REJECT_VENDOR_MISMATCH);
        continue;
      }
    }

    const sku = nullable(raw["Stock #"]);
    const certNumber = nullable(raw["Cert #"]);
    const feedRowKey = sku ?? certNumber;
    if (!feedRowKey) {
      tally(REJECT_NO_FEED_ROW_ID);
      continue;
    }

    const weightCt = numericOrNull(raw.Weight);
    const pricePerCt = numericOrNull(raw["Price per carat"]);
    const length = numericOrNull(raw.Measurements1);
    const width = numericOrNull(raw.Measurements2);
    const depth = numericOrNull(raw.Measurements3);
    const ratio = length !== null && width !== null && width !== 0
      ? Math.round((length / width) * 100) / 100
      : null;
    const totalPrice =
      pricePerCt !== null && weightCt !== null
        ? Math.round(pricePerCt * weightCt * 100) / 100
        : null;

    if (target.kind === "gemstone") {
      const colorRaw = nullable(raw["Fancy Color"]) ?? nullable(raw.Color);
      rows.push({
        kind: "gemstone",
        feedRowId: `Gems-${feedRowKey}`,
        feedRowIndex,
        sku: sku ?? feedRowKey,
        varietyRaw: gemstoneVariety(raw),
        shapeRaw: nullable(raw.Shape),
        colorRaw,
        weightCt,
        lengthMm: length,
        widthMm: width,
        depthMm: depth,
        ratio,
        basePriceUsd: totalPrice,
        basePricePerCtUsd: pricePerCt,
        certLab: nullable(raw.Lab),
        certNumber,
        certUrl: nullable(raw["Certificate URL"]),
        imageUrl: stripVendorHost(pickMediaUrl(nullable(raw.PHOTO), "image")),
        // Second image ("gem on hand"): the vendor serves these from its own host
        // (radiia.fantasy.mn), so it can't go through stripVendorHost like PHOTO —
        // that would always null it. Keep the raw vendor URL; it's never sent to the
        // browser (the portal streams it through a same-domain proxy, Gate §8).
        image2Url: secondImageUrl(nullable(raw.Image)),
        videoUrl: stripVendorHost(pickMediaUrl(nullable(raw.VIDEO), "video")),
        origin: gemstoneOrigin(raw),
        treatment: nullable(raw.Treatment),
        rawFeedRow: { ...raw }
      });
    } else {
      rows.push({
        kind: "diamond",
        feedRowId: `${target.vendor}-${feedRowKey}`,
        feedRowIndex,
        vendor: target.vendor,
        origin: target.origin,
        sku: sku ?? feedRowKey,
        shapeRaw: nullable(raw.Shape),
        weightCt,
        colorWhite: nullable(raw.Color),
        fancyColor: nullable(raw["Fancy Color"]),
        fancyIntensity: nullable(raw["Fancy Intensity"]),
        fancyOvertone: nullable(raw["Fancy Overtone"]),
        clarity: nullable(raw.Clarity),
        cutGrade: nullable(raw["Cut Grade"]),
        polish: nullable(raw.Polish),
        symmetry: nullable(raw.Symmetry),
        fluorescence: nullable(raw.Fluorescence),
        lengthMm: length,
        widthMm: width,
        depthMm: depth,
        ratio,
        depthPct: numericOrNull(raw["Depth %"]),
        tablePct: numericOrNull(raw["Table %"]),
        girdle: nullable(raw.Girdle),
        culet: nullable(raw.Culet),
        certLab: nullable(raw.Lab),
        certNumber,
        certUrl: nullable(raw["Certificate URL"]),
        treatment: nullable(raw.Treatment),
        growthMethod: nullable(raw.GrowthMethod),
        basePricePerCtUsd: pricePerCt,
        basePriceUsd: totalPrice,
        state: nullable(raw.State),
        country: nullable(raw.Country),
        photoUrl: stripVendorHost(pickMediaUrl(nullable(raw.PHOTO), "image")),
        videoUrl: stripVendorHost(pickMediaUrl(nullable(raw.VIDEO), "video")),
        rawFeedRow: { ...raw }
      });
    }
  }

  return {
    rows,
    rejected: Array.from(rejectCounts, ([reason, count]) => ({ reason, count }))
  };
}


const PARCEL_TYPE_COLUMNS = [
  "Item",
  "Stock #",
  "Type",
  "GemType",
  "Item Type",
  "ItemType",
  "Listing Type",
  "ListingType",
  "Lot Type",
  "LotType"
];

function isParcel(raw: Record<string, string>): boolean {
  const parcelCount = numericOrNull(raw["Parcel number of stones"]);
  if (parcelCount !== null && parcelCount > 1) return true;

  for (const col of PARCEL_TYPE_COLUMNS) {
    const token = (raw[col] ?? "").trim().toLowerCase().replace(/[\s_-]/g, "");
    if (token === "parcel" || token === "parcelgem") return true;
  }
  return false;
}

function passesRegionFilter(raw: Record<string, string>): boolean {
  const country = (raw.Country ?? "").trim().toUpperCase();
  if (country && country !== "USA" && country !== "US" && country !== "UNITED STATES") {
    return false;
  }
  const state = (raw.State ?? "").trim().toUpperCase();
  if (state && !ALLOWED_STATES.has(state)) {
    return false;
  }
  return true;
}

function stripVendorHost(url: string | null): string | null {
  if (!url) return null;
  const match = url.match(/^https?:\/\/[^/]*\.fantasy\.mn(?::\d+)?/i);
  if (match) return null;
  return url;
}

const VIDEO_FILE_RE = /\.(mp4|webm|ogg|mov|m4v)(\?|#|$)/i;
const IMAGE_FILE_RE = /\.(jpe?g|png|gif|webp|avif|bmp|svg)(\?|#|$)/i;

// A single PHOTO/VIDEO feed cell sometimes contains two URLs jammed together
// with no separator — the vendor's VIDEO column leaks the PHOTO url onto the
// end, e.g. "https://…/x.mp4?tr=f-mp4https://…/y.png?tr=f-jpg". That makes the
// stored URL un-loadable (broke video playback on ~half the gemstones). Split
// on each embedded http(s):// boundary and keep the segment that matches the
// column's own media type, so VIDEO keeps the video and PHOTO keeps the image.
function pickMediaUrl(raw: string | null, kind: "video" | "image"): string | null {
  if (!raw) return null;
  const segments = raw
    .split(/(?=https?:\/\/)/i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length <= 1) return raw;
  const prefer = kind === "video" ? VIDEO_FILE_RE : IMAGE_FILE_RE;
  const avoid = kind === "video" ? IMAGE_FILE_RE : VIDEO_FILE_RE;
  return (
    segments.find((u) => prefer.test(u)) ??
    segments.find((u) => !avoid.test(u)) ??
    segments[0]
  );
}

// Validate + normalize the gemstone "Image" (second image) cell. The vendor's
// filenames are messy (spaces, stray punctuation) and some rows carry a directory
// URL with no file (".../api/LotImage/"). Accept only a real http(s) URL that
// points at a file; return the WHATWG-normalized href so the proxy can fetch it
// without further encoding. Anything else → null.
function secondImageUrl(raw: string | null): string | null {
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.pathname.endsWith("/")) return null; // directory URL, no filename
  return parsed.href;
}

function nullable(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

const GEMSTONE_VARIETY_KEYS = [
  "Type",
  "Variety",
  "Gem Type",
  "GemType",
  "Gemstone Type",
  "GemstoneType",
  "Stone Type",
  "StoneType",
  "Item Type",
  "ItemType",
  "Gem Variety",
  "GemVariety",
  "Gemstone Variety"
];

function gemstoneVariety(raw: Record<string, string>): string | null {
  for (const key of GEMSTONE_VARIETY_KEYS) {
    const value = nullable(raw[key]);
    if (value) return value;
  }
  return null;
}

const GEMSTONE_ORIGIN_KEYS = [
  "GemOrigin",
  "Gem Origin",
  "Origin",
  "Country of Origin",
  "CountryOfOrigin",
  "Country Of Origin",
  "Source",
  "Provenance"
];

function gemstoneOrigin(raw: Record<string, string>): string | null {
  for (const key of GEMSTONE_ORIGIN_KEYS) {
    const value = nullable(raw[key]);
    if (value) return value;
  }
  return null;
}

function numericOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}
