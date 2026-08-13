import { parse } from "csv-parse/sync";

import {
  ImsInboundItemInputSchema,
  type ImsCsvCategory,
  type ImsCsvRowResult,
  type ImsInboundItemInput,
  type ImsParseInboundCsvResult
} from "@/contract";

import { isLegacyXls, isZipArchive, readWorkbookGrid, WorkbookError } from "./xlsx-import";

function normalizeHeader(h: string): string {
  return h.split("(")[0].toLowerCase().replace(/%/g, "pct").replace(/[^a-z0-9]/g, "");
}

function hintAliases(header: string): string[] {
  return /\b(parcel|pair|single)\b/i.test(header) ? ["lottype"] : [];
}

const LOT_TYPE_VALUE = /^(parcels?|pairs?|singles?)$/i;

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
function str(raw: string): string | undefined {
  const t = (raw ?? "").trim();
  return t === "" ? undefined : t;
}

// Fantasy prices wholesale and retail as a LINE TOTAL, while we store per carat.
// Divide rather than make her add a formula column to every export.
//
// A zero total is Fantasy's empty (its "Total Retail Price" is 0 on every row of
// both samples), so it stays null instead of asserting the stones are worth
// nothing — a real zero price would be indistinguishable from an unfilled one.
function perCtFromTotal(total: number | null, weightCt: number | null): number | null {
  if (total === null || total <= 0) return null;
  if (weightCt === null || weightCt <= 0) return null;
  return Math.round((total / weightCt) * 100) / 100;
}

function toSubtype(raw: string): "SINGLE" | "PAIR" | "PARCEL" {
  const s = (raw ?? "").toLowerCase();
  if (s.includes("parcel")) return "PARCEL";
  if (s.includes("pair")) return "PAIR";
  return "SINGLE"; // default (Lot Type is nominally required; be forgiving)
}
function isClosedLine(raw: string): boolean {
  return /^(closed|cancell?ed|void(ed)?|inactive)$/i.test((raw ?? "").trim());
}

function toNaturalOrLab(raw: string): "NATURAL" | "LAB" | undefined {
  const s = (raw ?? "").toLowerCase();
  if (s.includes("lab")) return "LAB";
  if (s.includes("nat")) return "NATURAL";
  return undefined;
}

function splitDiamondColor(raw: string): { color: string | undefined; fancyColor: string | undefined } {
  const v = (raw ?? "").trim();
  if (v === "") return { color: undefined, fancyColor: undefined };
  if (/fancy/i.test(v)) return { color: undefined, fancyColor: v };
  return { color: v, fancyColor: undefined };
}

const HEADER_SIGNALS = new Set([
  "sku", "radiiasku", "stock", "vendorsku",
  "shape", "weight", "carat", "caratweight", "weightct", "qty", "quantity",
  "color", "clarity", "cut", "cutgrade", "lab", "certno", "certnumber",
  "gemtype", "stonetype", "lottype", "origin", "treatment",
  "cost", "costpercarat", "pricepct",
  "metal", "jewelrytype", "materialtype", "description"
]);

// Only the top of the sheet: past this, a "header" is a mis-scored data row.
const HEADER_SCAN_ROWS = 10;

export function findHeaderRow(records: string[][]): number {
  let best = 0;
  let bestScore = 0;
  const limit = Math.min(records.length, HEADER_SCAN_ROWS);
  for (let i = 0; i < limit; i++) {
    const keys = new Set(records[i].map(normalizeHeader).filter(Boolean));
    let score = 0;
    for (const k of keys) if (HEADER_SIGNALS.has(k)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return bestScore >= 2 ? best : 0;
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
    const weightCt = num(get(["carat", "caratweight", "caratwt", "weight", "weightct", "carats", "ct", "totalcarat", "totalcaratweight", "tcw"]));
    const stone: Record<string, unknown> = {
      shape: str(get(["shape"])),
      weightCt,
      quantity: num(get(["quantity", "qty"])),
      color,
      fancyColor,
      clarity: str(get(["clarity"])),
      cutGrade: str(get(["cut", "cutgrade"])),
      polish: str(get(["pol", "polish"])),
      symmetry: str(get(["symm", "symmetry"])),
      fluorescence: str(get(["fluo", "fluorescence", "fluor"])),
      lengthMm: num(get(["length", "m1"])),
      widthMm: num(get(["width", "m2"])),
      heightMm: num(get(["depth", "height", "m3"])), // "Depth" (mm) among the mm dims = physical height
      depthPct: num(get(["depthpct", "depthpercent"])), // distinct "Depth %" column
      tablePct: num(get(["tablepct", "tablepercent", "table"])),
      ratio: num(get(["ratio"])),
      lab: str(get(["lab"])),
      certNumber: str(get(["certno", "certnumber", "certificate", "certificateno", "certificatenumber", "cert"])),
      treatment: str(get(["treatment"])),
      origin: str(get(["origin"])),
      costPerCt: num(get(["costpercarat", "costperct", "cost", "pricepercarat", "priceperct", "pricepct"])),
      wholesalePricePerCt:
        num(get(["wholesalepercarat", "wholesaleperct", "wholesalepricepercarat", "wholesalepriceperct", "wholesaleprice", "wholesale"])) ??
        perCtFromTotal(num(get(["totalwholesaleprice"])), weightCt),
      retailPricePerCt:
        num(get(["retailpercarat", "retailperct", "retailpricepercarat", "retailpriceperct", "retailprice", "retail"])) ??
        perCtFromTotal(num(get(["totalretailprice"])), weightCt),
      photo1Url: str(get(["image1", "photo1", "image"])),
      photo2Url: str(get(["image2", "photo2"])),
      videoUrl: str(get(["video"]))
    };
    if (category === "diamonds") {
      stone.gemType = "Diamond";
      stone.naturalOrLab = toNaturalOrLab(get(["stonetype", "type", "naturalorlab"]));
    } else {
      stone.gemType = str(get(["stonetype", "type", "gemtype", "variety"]));
      stone.naturalOrLab = toNaturalOrLab(get(["naturalorlab"]));
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

// A whole-file failure, shaped like a normal result so the preview can render it
// the same way as a bad row instead of the caller special-casing an exception.
function fileError(category: ImsCsvCategory, error: string, sheetName: string | null = null): ImsParseInboundCsvResult {
  return {
    category,
    sheetName,
    totalRows: 0,
    okCount: 0,
    errorCount: 1,
    closedCount: 0,
    restockCount: 0,
    rows: [{ rowNumber: 0, sku: null, ok: false, error, item: null }],
    items: []
  };
}

// The shared core: a string grid → validated inbound items. The header is found
// rather than assumed (see findHeaderRow); anything above it is preamble.
// CSV text and .xlsx cells both arrive here, so the two formats can't drift.
function parseRecords(
  category: ImsCsvCategory,
  records: string[][],
  sheetName: string | null
): ImsParseInboundCsvResult {
  const headerRow = records.length ? findHeaderRow(records) : 0;
  if (records.length < headerRow + 2) {
    return fileError(
      category,
      sheetName
        ? `No data rows on the "${sheetName}" tab (expected a header row + at least one item) — check the category matches the tab.`
        : "No data rows found (expected a header row + at least one item).",
      sheetName
    );
  }

  const headerIndex = new Map<string, number>();
  const collidedColumns: number[] = [];
  records[headerRow].forEach((h, i) => {
    const key = normalizeHeader(h);
    if (key && !headerIndex.has(key)) headerIndex.set(key, i);
    else if (key) collidedColumns.push(i);
    // First non-colliding column wins each alias, so the real Stone Type column
    // keeps "stonetype" and a mislabeled Lot Type column still claims "lottype".
    for (const alias of hintAliases(h)) {
      if (!headerIndex.has(alias)) headerIndex.set(alias, i);
    }
  });

  const dataRows = records.slice(headerRow + 1);
  claimLotTypeByValue(headerIndex, collidedColumns, dataRows);
  const rows: ImsCsvRowResult[] = [];
  const items: ImsInboundItemInput[] = [];
  let closedCount = 0;

  dataRows.forEach((row, i) => {
    const rowNumber = i + 1;
    // Skip a row that is entirely blank (some exports pad trailing rows).
    if (row.every((c) => (c ?? "").trim() === "")) return;

    const get = makeGet(headerIndex, row);
    // A Fantasy export carries settled lines alongside live ones (Jennifer
    // 2026-08-12: "I'm fine with closed not being imported, because it means
    // it's no longer active anyway"). Silently, and only when the column is
    // present: a closed line is not a row she needs to see an error about.
    if (isClosedLine(get(["doclinestatus", "linestatus"]))) {
      closedCount++;
      return;
    }

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
    sheetName,
    totalRows: rows.length,
    okCount: rows.length - errorCount,
    errorCount,
    closedCount,
    // Set by annotateRestocks once the parse is checked against live inventory;
    // a bare parse knows nothing about what is already in stock.
    restockCount: 0,
    rows,
    items
  };
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
    return fileError(category, `CSV parse failed: ${detail}`);
  }
  return parseRecords(category, records, null);
}

// Excel's "Unicode Text" export is UTF-16LE; everything else is UTF-8 (whose BOM
// csv-parse strips itself). Sniffing the BOM keeps a wrongly-saved CSV readable
// instead of failing on a header full of NUL bytes.
function decodeText(bytes: Buffer): string {
  if (bytes.length > 1 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.toString("utf16le", 2);
  if (bytes.length > 1 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return bytes.subarray(2).swap16().toString("utf16le");
  }
  return bytes.toString("utf8");
}

/**
 * Parse an uploaded file, whatever it is. Routes on content rather than the file
 * name — a workbook renamed .csv is still a workbook — and falls back to CSV so
 * an oddly-named text export still imports.
 */
export function parseInventoryUpload(category: ImsCsvCategory, bytes: Buffer): ImsParseInboundCsvResult {
  if (bytes.length === 0) return fileError(category, "That file is empty.");

  if (isZipArchive(bytes)) {
    try {
      const { sheetName, records } = readWorkbookGrid(bytes, category);
      return parseRecords(category, records, sheetName);
    } catch (e) {
      if (e instanceof WorkbookError) return fileError(category, `Could not read that workbook — ${e.message}.`);
      const detail = e instanceof Error ? e.message : "unknown error";
      return fileError(category, `Excel read failed: ${detail}`);
    }
  }

  if (isLegacyXls(bytes)) {
    return fileError(
      category,
      "That's an old .xls workbook. Open it in Excel and re-save as .xlsx (or .csv), then import again."
    );
  }

  return parseInventoryCsv(category, decodeText(bytes));
}
