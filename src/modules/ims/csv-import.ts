/**
 * csv-import — forgiving parser turning an uploaded inventory CSV (Jennifer's
 * 7-13 template, one tab/category) into inbound item payloads for a Bill In /
 * Memo In. Diamonds + Gems share the STONE shape; Jewelry / Other map to their
 * detail tables. See docs/phase-h/inventory-schema-baseline.md §4 for the column
 * maps. This module PARSES ONLY — the caller previews, then POSTs the ok items to
 * the existing inbound-create endpoint.
 *
 * Forgiving by design: headers match case/space/punctuation-insensitively with
 * aliases; a header's trailing "(…)" hint is ignored; money/number cells tolerate
 * $ and thousands separators. Each built row is validated against the real
 * ImsInboundItemInputSchema so a preview error is exactly what the create would
 * reject — no row can slip through and 400 later.
 */

import { parse } from "csv-parse/sync";

import {
  ImsInboundItemInputSchema,
  type ImsCsvCategory,
  type ImsCsvRowResult,
  type ImsInboundItemInput,
  type ImsParseInboundCsvResult
} from "@/contract";

// "RADIIA SKU" → "radiiasku"; "Stone Type (Natural, Lab)" → "stonetype";
// "Cost per carat" → "costpercarat". Drop any "(…)" hint, keep a–z0–9. "%" → "pct"
// FIRST, so "Depth %" → "depthpct" stays distinct from the "Depth" (mm) column
// (both would otherwise collapse to "depth"); likewise "Table %" → "tablepct".
function normalizeHeader(h: string): string {
  return h.split("(")[0].toLowerCase().replace(/%/g, "pct").replace(/[^a-z0-9]/g, "");
}

// Recover aliases from a header's parenthetical hint. Jennifer's Memo In / Bill In
// template mislabels the Lot Type column as a *second* "Stone Type (Parcel, Pair,
// Single)" — its base label ("stonetype") collides with the real Stone Type column
// and would be dropped, silently defaulting every row to SINGLE. Any header whose
// text names the lot-type values is therefore also indexed under "lottype".
function hintAliases(header: string): string[] {
  return /\b(parcel|pair|single)\b/i.test(header) ? ["lottype"] : [];
}

const LOT_TYPE_VALUE = /^(parcels?|pairs?|singles?)$/i;

// Last-ditch rescue for a Lot Type column that is BOTH duplicate-named and
// hint-less — Jennifer's 7-30 sheet heads it plain "Stone type" (same text as the
// real gem-variety column, no "(Parcel, Pair, Single)" to key off). Dropping it
// would default every row to SINGLE, silently turning a parcel into one stone,
// which is exactly the case the melee pilot's draw-down depends on. So: only for
// columns whose header collided with an earlier one, and only when EVERY non-empty
// value in the column is literally a lot-type word, claim "lottype". Header text
// still wins — this never overrides a properly labeled column.
function claimLotTypeByValue(
  headerIndex: Map<string, number>,
  collidedColumns: number[],
  dataRows: string[][]
): void {
  if (headerIndex.has("lottype")) return;
  for (const col of collidedColumns) {
    const values = dataRows
      .map((row) => (row[col] ?? "").trim())
      .filter((v) => v !== "");
    if (values.length > 0 && values.every((v) => LOT_TYPE_VALUE.test(v))) {
      headerIndex.set("lottype", col);
      return;
    }
  }
}

// "Show on website?" → visibleOnPortal. Anything affirmative is true, anything
// negative is false, blank/unrecognized leaves the field unset (the item then
// takes the server default: not visible — nothing leaks by accident).
function bool(raw: string): boolean | undefined {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "") return undefined;
  if (/^(y|yes|true|1|x|show|visible)$/.test(s)) return true;
  if (/^(n|no|false|0|hide|hidden)$/.test(s)) return false;
  return undefined;
}

// Strip $, thousands separators and spaces; parse to a finite number or null.
function num(raw: string): number | null {
  if (raw == null) return null;
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Optional string → trimmed value or undefined (so a blank leaves the field unset
// rather than sending "").
function str(raw: string): string | undefined {
  const t = (raw ?? "").trim();
  return t === "" ? undefined : t;
}

function toSubtype(raw: string): "SINGLE" | "PAIR" | "PARCEL" {
  const s = (raw ?? "").toLowerCase();
  if (s.includes("parcel")) return "PARCEL";
  if (s.includes("pair")) return "PAIR";
  return "SINGLE"; // default (Lot Type is nominally required; be forgiving)
}

function toNaturalOrLab(raw: string): "NATURAL" | "LAB" | undefined {
  const s = (raw ?? "").toLowerCase();
  if (s.includes("lab")) return "LAB";
  if (s.includes("nat")) return "NATURAL";
  return undefined;
}

// Diamonds collapse white grade + fancy into one "Color" column. Keep it lossless:
// a "Fancy …" value goes to fancyColor (color left null); anything else is a white
// grade → color. (A finer hue/intensity split is deliberately not attempted — a
// wrong split is worse than one faithful field.)
function splitDiamondColor(raw: string): { color: string | undefined; fancyColor: string | undefined } {
  const v = (raw ?? "").trim();
  if (v === "") return { color: undefined, fancyColor: undefined };
  if (/fancy/i.test(v)) return { color: undefined, fancyColor: v };
  return { color: v, fancyColor: undefined };
}

// A single data row's header→value accessor: first matching alias wins.
type RowGet = (aliases: string[]) => string;

function makeGet(headerIndex: Map<string, number>, row: string[]): RowGet {
  return (aliases: string[]) => {
    for (const a of aliases) {
      const idx = headerIndex.get(a);
      if (idx !== undefined && idx < row.length) {
        const v = (row[idx] ?? "").trim();
        if (v !== "") return v;
      }
    }
    return "";
  };
}

// Build the raw (pre-validation) inbound item for a row, by category. Returns a
// plain object; the caller validates it against the zod schema.
function buildRawItem(category: ImsCsvCategory, get: RowGet): Record<string, unknown> {
  const core: Record<string, unknown> = {
    sku: str(get(["radiiasku", "sku", "stock"])),
    itemName: str(get(["itemname", "name"])),
    vendorSku: str(get(["vendorsku"])),
    visibleOnPortal: bool(get(["showonwebsite", "showonportal", "visibleonportal", "website", "portal"]))
  };

  if (category === "diamonds" || category === "gems") {
    const { color, fancyColor } = category === "diamonds"
      ? splitDiamondColor(get(["color"]))
      : { color: str(get(["color"])), fancyColor: undefined };
    const stone: Record<string, unknown> = {
      shape: str(get(["shape"])),
      // "Carat" (7-13 template) and "Carat weight" (Jennifer's 7-30 sheet) are the
      // same column; a miss here rejects the whole row, so spell out the variants.
      weightCt: num(get(["carat", "caratweight", "caratwt", "weight", "weightct", "carats", "ct", "totalcarat", "totalcaratweight", "tcw"])),
      quantity: num(get(["quantity", "qty"])),
      color,
      fancyColor,
      clarity: str(get(["clarity"])),
      polish: str(get(["pol", "polish"])),
      symmetry: str(get(["symm", "symmetry"])),
      fluorescence: str(get(["fluo", "fluorescence", "fluor"])),
      lengthMm: num(get(["length"])),
      widthMm: num(get(["width"])),
      heightMm: num(get(["depth", "height"])), // "Depth" (mm) among the mm dims = physical height
      depthPct: num(get(["depthpct", "depthpercent"])), // distinct "Depth %" column
      tablePct: num(get(["tablepct", "tablepercent", "table"])),
      ratio: num(get(["ratio"])),
      lab: str(get(["lab"])),
      certNumber: str(get(["certno", "certnumber", "certificate", "certificateno", "certificatenumber", "cert"])),
      treatment: str(get(["treatment"])),
      origin: str(get(["origin"])),
      costPerCt: num(get(["costpercarat", "costperct", "cost"])),
      // The 7-13 template heads these "Wholesale per carat"; Jennifer's 7-30 sheet
      // says "Wholesale price per carat" / "Retail price per carat". Same columns.
      wholesalePricePerCt: num(get(["wholesalepercarat", "wholesaleperct", "wholesalepricepercarat", "wholesalepriceperct", "wholesaleprice", "wholesale"])),
      retailPricePerCt: num(get(["retailpercarat", "retailperct", "retailpricepercarat", "retailpriceperct", "retailprice", "retail"])),
      photo1Url: str(get(["image1", "photo1", "image"])),
      photo2Url: str(get(["image2", "photo2"])),
      videoUrl: str(get(["video"]))
    };
    if (category === "diamonds") {
      stone.naturalOrLab = toNaturalOrLab(get(["stonetype", "type", "naturalorlab"]));
    } else {
      stone.gemType = str(get(["stonetype", "type", "gemtype", "variety"]));
    }
    return {
      itemType: "STONE",
      itemSubtype: toSubtype(get(["lottype", "lot", "subtype"])),
      ...core,
      stone
    };
  }

  if (category === "jewelry") {
    return {
      itemType: "JEWELRY",
      ...core,
      jewelry: {
        jewelryItemType: str(get(["jewelrytype", "itemtype", "type"])),
        description: str(get(["description", "desc"])),
        quantity: num(get(["qty", "quantity"])),
        metal: str(get(["metal"])),
        lengthMm: num(get(["length"])),
        ringSize: str(get(["size", "ringsize"])),
        mm: num(get(["mm"])),
        metalWeightGrams: num(get(["metalweight", "metalweightgrams", "weightgrams", "grams"])),
        productionCost: num(get(["cost", "productioncost"])),
        wholesalePrice: num(get(["wholesaleprice", "wholesale"])),
        retailPrice: num(get(["retailprice", "retail"])),
        brand: str(get(["brand"])),
        photo1Url: str(get(["image1", "image", "photo1", "photo"])) // one photo, no video (Jennifer 07-23)
      }
    };
  }

  // other materials
  return {
    itemType: "OTHER_MATERIAL",
    ...core,
    material: {
      category: str(get(["category"])),
      subtype: str(get(["materialtype", "subtype", "material"])),
      quantity: num(get(["qty", "quantity"])),
      metalType: str(get(["metal", "metaltype"])),
      lengthMm: num(get(["length"])),
      size: str(get(["size"])),
      mm: num(get(["mm"])),
      cost: num(get(["cost"])),
      wholesalePrice: num(get(["wholesaleprice", "wholesale"])),
      photo1Url: str(get(["image1", "image", "photo1", "photo"])) // one photo, no video (Jennifer 07-23)
    }
  };
}

// Turn a failed zod parse into one friendly, row-scoped sentence.
function friendlyError(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): string {
  const first = issues[0];
  if (!first) return "Invalid row";
  const field = first.path[first.path.length - 1];
  const label = typeof field === "string" ? field : "row";
  const msg = /number|nan|received null|received nan/i.test(first.message)
    ? "must be a number"
    : /required|invalid input|received undefined/i.test(first.message)
      ? "is required"
      : first.message;
  return `${label} ${msg}`;
}

export function parseInventoryCsv(category: ImsCsvCategory, csvText: string): ImsParseInboundCsvResult {
  let records: string[][];
  try {
    records = parse(csvText, {
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true
    }) as string[][];
  } catch (e) {
    const detail = e instanceof Error ? e.message : "could not read the file";
    return {
      category,
      totalRows: 0,
      okCount: 0,
      errorCount: 1,
      rows: [{ rowNumber: 0, sku: null, ok: false, error: `CSV parse failed: ${detail}`, item: null }],
      items: []
    };
  }

  if (records.length < 2) {
    return {
      category,
      totalRows: 0,
      okCount: 0,
      errorCount: 1,
      rows: [
        { rowNumber: 0, sku: null, ok: false, error: "No data rows found (expected a header row + at least one item).", item: null }
      ],
      items: []
    };
  }

  const headerIndex = new Map<string, number>();
  const collidedColumns: number[] = [];
  records[0].forEach((h, i) => {
    const key = normalizeHeader(h);
    if (key && !headerIndex.has(key)) headerIndex.set(key, i);
    else if (key) collidedColumns.push(i);
    // First non-colliding column wins each alias, so the real Stone Type column
    // keeps "stonetype" and a mislabeled Lot Type column still claims "lottype".
    for (const alias of hintAliases(h)) {
      if (!headerIndex.has(alias)) headerIndex.set(alias, i);
    }
  });

  const dataRows = records.slice(1);
  claimLotTypeByValue(headerIndex, collidedColumns, dataRows);
  const rows: ImsCsvRowResult[] = [];
  const items: ImsInboundItemInput[] = [];

  dataRows.forEach((row, i) => {
    const rowNumber = i + 1;
    // Skip a row that is entirely blank (some exports pad trailing rows).
    if (row.every((c) => (c ?? "").trim() === "")) return;

    const get = makeGet(headerIndex, row);
    const sku = str(get(["radiiasku", "sku", "stock"])) ?? null;
    const raw = buildRawItem(category, get);
    const parsed = ImsInboundItemInputSchema.safeParse(raw);
    if (parsed.success) {
      items.push(parsed.data);
      rows.push({ rowNumber, sku, ok: true, error: null, item: parsed.data });
    } else {
      rows.push({ rowNumber, sku, ok: false, error: friendlyError(parsed.error.issues), item: null });
    }
  });

  const errorCount = rows.filter((r) => !r.ok).length;
  return {
    category,
    totalRows: rows.length,
    okCount: rows.length - errorCount,
    errorCount,
    rows,
    items
  };
}
