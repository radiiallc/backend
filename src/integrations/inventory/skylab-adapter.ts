import { isDirectImageFile, isDirectVideoFile } from "@/domain";

import { env } from "../../env";

import type { ParsedDiamond, RapNetParseSummary } from "./rapnet-parser";
import type { SkylabStone } from "./skylab-api";

const REJECT_NON_STOCK_STATUS = "non-stock-status";
const REJECT_NO_FEED_ROW_ID = "no-feed-row-id";

// --- scalar coercion --------------------------------------------------------

function num(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function str(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const s = typeof value === "number" ? String(value) : value.trim();
  return s === "" ? null : s;
}

// --- availability -----------------------------------------------------------

export function skylabLotStatus(stone: SkylabStone): string {
  return (str(stone.lot_status) ?? "").toUpperCase();
}

export function isSkylabAvailable(stone: SkylabStone): boolean {
  return env.skylabAvailableStatuses.includes(skylabLotStatus(stone));
}

// --- colour (white grade vs. fancy) -----------------------------------------

const WHITE_COLOR_RE = /^[D-Z](?:\s*-\s*[D-Z])?$/;

const FANCY_HUE: Record<string, string> = {
  YL: "Yellow", Y: "Yellow", YE: "Yellow", YEL: "Yellow", YELLOW: "Yellow",
  PK: "Pink", PN: "Pink", PINK: "Pink",
  BL: "Blue", BU: "Blue", BLUE: "Blue",
  GN: "Green", GR: "Green", GRN: "Green", GREEN: "Green",
  OR: "Orange", ORANGE: "Orange",
  BN: "Brown", BR: "Brown", BROWN: "Brown",
  PU: "Purple", PUR: "Purple", PURPLE: "Purple",
  GY: "Gray", GRAY: "Gray", GREY: "Gray",
  RD: "Red", RED: "Red",
  BK: "Black", BLACK: "Black",
  CG: "Cognac", CH: "Champagne"
};

const FANCY_INTENSITY: Record<string, string> = {
  F: "Fancy", FL: "Fancy Light", FI: "Fancy Intense", FV: "Fancy Vivid",
  FD: "Fancy Deep", FDK: "Fancy Dark", FDP: "Fancy Deep",
  VL: "Very Light", L: "Light", FF: "Faint"
};

function expandFancyColor(raw: string): { color: string; intensity: string | null } {
  const tokens = raw.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  let hue: string | null = null;
  const intensityParts: string[] = [];
  for (const tok of tokens) {
    if (!hue && FANCY_HUE[tok]) {
      hue = FANCY_HUE[tok];
      continue;
    }
    intensityParts.push(tok);
  }
  const intensity = intensityParts.length
    ? intensityParts.map((t) => FANCY_INTENSITY[t] ?? t).join(" ")
    : null;
  const color = hue ? (intensity ? `${intensity} ${hue}` : hue) : raw.trim();
  return { color, intensity };
}

function splitColor(raw: string | null): {
  colorWhite: string | null;
  fancyColor: string | null;
  fancyIntensity: string | null;
} {
  if (!raw) return { colorWhite: null, fancyColor: null, fancyIntensity: null };
  const t = raw.trim();
  if (WHITE_COLOR_RE.test(t.toUpperCase())) {
    return { colorWhite: t.toUpperCase(), fancyColor: null, fancyIntensity: null };
  }
  const { color, intensity } = expandFancyColor(t);
  return { colorWhite: null, fancyColor: color, fancyIntensity: intensity };
}

// --- media + cert -----------------------------------------------------------

function httpUrlOrNull(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function pickMedia(stone: SkylabStone): { photoUrl: string | null; videoUrl: string | null } {
  const image = httpUrlOrNull(str(stone.image_link));
  const video = httpUrlOrNull(str(stone.video_link));
  const html = httpUrlOrNull(str(stone.html_link));

  const photoUrl = image && isDirectImageFile(image) ? image : null;

  let videoUrl: string | null = null;
  if (video && isDirectVideoFile(video)) videoUrl = video;
  else if (html) videoUrl = html;
  else if (image && !isDirectImageFile(image)) videoUrl = image;
  else videoUrl = video;

  return { photoUrl, videoUrl };
}

// --- row mapping ------------------------------------------------------------

type MapResult =
  | { ok: true; row: ParsedDiamond }
  | { ok: false; reason: string };

export function mapSkylabStone(stone: SkylabStone, feedRowIndex: number): MapResult {
  if (!isSkylabAvailable(stone)) {
    return { ok: false, reason: REJECT_NON_STOCK_STATUS };
  }

  const lotNo = str(stone.lot_no);
  const certNumber = str(stone.certificate);
  const feedRowKey = lotNo ?? certNumber;
  if (!feedRowKey) {
    return { ok: false, reason: REJECT_NO_FEED_ROW_ID };
  }

  const weightCt = num(stone.weight);
  const pricePerCt = num(stone.price_per_carat);
  const length = num(stone.length);
  const width = num(stone.width);
  const depth = num(stone.depth);
  const ratio =
    length !== null && width !== null && width !== 0
      ? Math.round((length / width) * 100) / 100
      : null;
  const basePriceUsd =
    pricePerCt !== null && weightCt !== null
      ? Math.round(pricePerCt * weightCt * 100) / 100
      : null;

  const color = splitColor(str(stone.color));
  const media = pickMedia(stone);

  return {
    ok: true,
    row: {
      kind: "diamond",
      feedRowId: `Skylab-${feedRowKey}`,
      feedRowIndex,
      vendor: "Skylab",
      origin: "Lab",
      sku: lotNo ?? feedRowKey,
      shapeRaw: str(stone.shape),
      weightCt,
      colorWhite: color.colorWhite,
      fancyColor: color.fancyColor,
      fancyIntensity: color.fancyIntensity,
      fancyOvertone: null,
      clarity: str(stone.clarity),
      cutGrade: str(stone.cut_grade),
      polish: str(stone.polish),
      symmetry: str(stone.symmetry),
      fluorescence: str(stone.fluor),
      lengthMm: length,
      widthMm: width,
      depthMm: depth,
      ratio,
      depthPct: num(stone.depth_percent),
      tablePct: num(stone.table_percent),
      girdle: str(stone.girdle),
      culet: str(stone.culet),
      certLab: str(stone.lab),
      certNumber,
      certUrl: httpUrlOrNull(str(stone.certificate_link)),
      treatment: null,
      growthMethod: null,
      basePricePerCtUsd: pricePerCt,
      basePriceUsd,
      state: null,
      country: null,
      photoUrl: media.photoUrl,
      videoUrl: media.videoUrl,
      rawFeedRow: {}
    }
  };
}

export function parseSkylabStock(
  stones: SkylabStone[]
): RapNetParseSummary<ParsedDiamond> {
  const rows: ParsedDiamond[] = [];
  const rejectCounts = new Map<string, number>();
  const tally = (reason: string) =>
    rejectCounts.set(reason, (rejectCounts.get(reason) ?? 0) + 1);

  for (let i = 0; i < stones.length; i++) {
    const result = mapSkylabStone(stones[i], i);
    if (result.ok) rows.push(result.row);
    else tally(result.reason);
  }

  return {
    rows,
    rejected: Array.from(rejectCounts, ([reason, count]) => ({ reason, count }))
  };
}
