import { parse } from "csv-parse/sync";

import { isFancyIntensity, parseFancyColor } from "@/domain";
import {
  ImsInboundItemInputSchema,
  type ImsCsvCategory,
  type ImsCsvRowResult,
  type ImsInboundItemInput,
  type ImsParseInboundCsvResult
} from "@/contract";

import { isLegacyXls, isZipArchive, readWorkbookGrid, WorkbookError } from "./xlsx-import";

export function normalizeHeader(h: string): string {
  return h.split("(")[0].toLowerCase().replace(/%/g, "pct").replace(/[^a-z0-9]/g, "");
}

export function hintAliases(header: string): string[] {
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

function perCtFromTotal(total: number | null, weightCt: number | null): number | null {
  if (total === null || total <= 0) return null;
  if (weightCt === null || weightCt <= 0) return null;
  return Math.round((total / weightCt) * 100) / 100;
}

/**
 * Brands rarely quote both a cost and a wholesale: a designer whose stock we
 * hold sends one or the other, and the blank column then leaves the price off
 * every Memo Out and Invoice struck against that stock. Where exactly one side
 * is given, mirror it — a supplier who names a single number means it for both.
 *
 * Only fills a blank. Two real numbers are left alone, and a row with neither
 * still fails validation rather than being invented at zero.
 */
function mirrorCostAndWholesale(
  cost: number | null,
  wholesale: number | null
): { cost: number | null; wholesale: number | null } {
  if (cost === null && wholesale !== null) return { cost: wholesale, wholesale };
  if (wholesale === null && cost !== null) return { cost, wholesale: cost };
  return { cost, wholesale };
}

function toSubtype(raw: string): "SINGLE" | "PAIR" | "PARCEL" {
  const s = (raw ?? "").toLowerCase();
  if (s.includes("parcel")) return "PARCEL";
  if (s.includes("pair")) return "PAIR";
  return "SINGLE";
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

type SplitColor = {
  color: string | undefined;
  fancyColor: string | undefined;
  fancyIntensity: string | undefined;
};

/**
 * Vendor sheets write a fancy colour either as one string ("Fancy Vivid Yellow")
 * or as two columns, so take an explicit intensity when the sheet has one and
 * fall back to splitting the written colour.
 */
function splitDiamondColor(raw: string, intensityRaw: string): SplitColor {
  const parsed = parseFancyColor(raw);
  const intensity = (intensityRaw ?? "").trim();
  if (intensity && isFancyIntensity(intensity) && !parsed.fancyIntensity) {
    // A separate Intensity column means the colour column holds the bare hue.
    const hue = parsed.fancyColor ?? parsed.color;
    if (hue) return { color: undefined, fancyColor: hue, fancyIntensity: intensity };
  }
  return {
    color: parsed.color ?? undefined,
    fancyColor: parsed.fancyColor ?? undefined,
    fancyIntensity: parsed.fancyIntensity ?? undefined
  };
}

const HEADER_SIGNALS = new Set([
  "sku", "radiiasku", "stock", "vendorsku",
  "shape", "weight", "carat", "caratweight", "weightct", "qty", "quantity",
  "color", "intensity", "clarity", "cut", "cutgrade", "lab", "certno", "certnumber",
  "gemtype", "stonetype", "lottype", "origin", "treatment",
  "cost", "costpercarat", "pricepct",
  "metal", "jewelrytype", "materialtype", "description"
]);

const HEADER_SCAN_ROWS = 10;

export function findHeaderRow(records: string[][]): number {
  let best = 0;
  let bestScore = 0;
  // Counts rows with content, not raw positions — a sheet whose header sits
  // below a run of untouched rows must not scan past it.
  let scanned = 0;
  for (let i = 0; i < records.length && scanned < HEADER_SCAN_ROWS; i++) {
    const keys = new Set(records[i].map(normalizeHeader).filter(Boolean));
    if (keys.size === 0) continue;
    scanned++;
    let score = 0;
    for (const k of keys) if (HEADER_SIGNALS.has(k)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return bestScore >= 2 ? best : 0;
}

export type RowGet = (aliases: string[]) => string;

export function makeGet(headerIndex: Map<string, number>, row: string[]): RowGet {
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

/**
 * Columns that on their own say "this line is a product". Attribute-only
 * columns — lab, certificate, colour, clarity, origin, treatment, images — are
 * deliberately absent: none of them identifies an item, so a row carrying
 * nothing else is spreadsheet residue rather than a line someone meant to
 * import. Excel hands us hundreds of such rows below the real data, and one
 * stray character in an attribute cell used to be enough to make a row look
 * real, fail validation and report a scary "row 176 — shape is required"
 * against a line the sender could not even find.
 */
const IDENTITY_ALIASES: string[][] = [
  ["radiiasku", "sku", "stock"],
  ["vendorsku"],
  ["itemname", "name"],
  ["shape"],
  ["carat", "caratweight", "caratwt", "weight", "weightct", "carats", "ct", "totalcarat", "totalcaratweight", "tcw"],
  ["quantity", "qty"],
  ["cost", "costpercarat", "costperct", "productioncost", "pricepercarat", "priceperct", "pricepct"],
  ["wholesale", "wholesaleprice", "wholesalepercarat", "wholesaleperct", "wholesalepricepercarat", "wholesalepriceperct", "totalwholesaleprice"],
  ["retail", "retailprice", "retailpercarat", "retailperct", "retailpricepercarat", "retailpriceperct", "totalretailprice"],
  ["stonetype", "type", "gemtype", "variety"],
  ["jewelrytype", "itemtype"],
  ["materialtype", "subtype", "material", "category"],
  ["metal", "metaltype"],
  ["metalweight", "metalweightgrams", "weightgrams", "grams"],
  ["description", "desc"],
  ["brand"]
];

function hasImportableSignal(get: RowGet): boolean {
  return IDENTITY_ALIASES.some((aliases) => get(aliases) !== "");
}

function buildRawItem(category: ImsCsvCategory, get: RowGet): Record<string, unknown> {
  const core: Record<string, unknown> = {
    sku: str(get(["radiiasku", "sku", "stock"])),
    itemName: str(get(["itemname", "name"])),
    vendorSku: str(get(["vendorsku"])),
    visibleOnPortal: bool(get(["showonwebsite", "showonportal", "visibleonportal", "website", "portal"]))
  };

  if (category === "diamonds" || category === "gems") {
    const { color, fancyColor, fancyIntensity } = category === "diamonds"
      ? splitDiamondColor(get(["color"]), get(["intensity", "fancyintensity", "colorintensity"]))
      : { color: str(get(["color"])), fancyColor: undefined, fancyIntensity: undefined };
    const weightCt = num(get(["carat", "caratweight", "caratwt", "weight", "weightct", "carats", "ct", "totalcarat", "totalcaratweight", "tcw"]));
    // Per-carat on both sides, and the wholesale may have come from a line total,
    // so resolve that first and mirror the two rates against each other.
    const stonePrices = mirrorCostAndWholesale(
      num(get(["costpercarat", "costperct", "cost", "pricepercarat", "priceperct", "pricepct"])),
      num(get(["wholesalepercarat", "wholesaleperct", "wholesalepricepercarat", "wholesalepriceperct", "wholesaleprice", "wholesale"])) ??
        perCtFromTotal(num(get(["totalwholesaleprice"])), weightCt)
    );
    const stone: Record<string, unknown> = {
      shape: str(get(["shape"])),
      weightCt,
      quantity: num(get(["quantity", "qty"])),
      color,
      fancyColor,
      fancyIntensity,
      clarity: str(get(["clarity"])),
      cutGrade: str(get(["cut", "cutgrade"])),
      polish: str(get(["pol", "polish"])),
      symmetry: str(get(["symm", "symmetry"])),
      fluorescence: str(get(["fluo", "fluorescence", "fluor"])),
      lengthMm: num(get(["length", "m1"])),
      widthMm: num(get(["width", "m2"])),
      heightMm: num(get(["depth", "height", "m3"])),
      depthPct: num(get(["depthpct", "depthpercent"])),
      tablePct: num(get(["tablepct", "tablepercent", "table"])),
      ratio: num(get(["ratio"])),
      lab: str(get(["lab"])),
      certNumber: str(get(["certno", "certnumber", "certificate", "certificateno", "certificatenumber", "cert"])),
      treatment: str(get(["treatment"])),
      origin: str(get(["origin"])),
      costPerCt: stonePrices.cost,
      wholesalePricePerCt: stonePrices.wholesale,
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
    const prices = mirrorCostAndWholesale(
      num(get(["cost", "productioncost"])),
      num(get(["wholesaleprice", "wholesale"]))
    );
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
        productionCost: prices.cost,
        wholesalePrice: prices.wholesale,
        retailPrice: num(get(["retailprice", "retail"])),
        brand: str(get(["brand"])),
        photo1Url: str(get(["image1", "image", "photo1", "photo"]))
      }
    };
  }

  const materialPrices = mirrorCostAndWholesale(
    num(get(["cost"])),
    num(get(["wholesaleprice", "wholesale"]))
  );
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
      cost: materialPrices.cost,
      wholesalePrice: materialPrices.wholesale,
      photo1Url: str(get(["image1", "image", "photo1", "photo"]))
    }
  };
}

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
    // The row number the sender can act on: the line as it appears in their
    // file, counting the header and anything above it. Reporting an offset from
    // the header instead sends them hunting for a row that isn't there.
    const rowNumber = headerRow + i + 2;
    if (row.every((c) => (c ?? "").trim() === "")) return;

    const get = makeGet(headerIndex, row);
    if (isClosedLine(get(["doclinestatus", "linestatus"]))) {
      closedCount++;
      return;
    }
    // Nothing on this row identifies an item — treat it as blank, not as an error.
    if (!hasImportableSignal(get)) return;

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
    restockCount: 0,
    rows,
    items
  };
}

export function parseInventoryCsv(category: ImsCsvCategory, csvText: string): ImsParseInboundCsvResult {
  let records: string[][];
  try {
    records = parse(csvText, {
      // Empty lines are KEPT so a record's index stays its line number — they
      // are discarded later as blank rows anyway, and dropping them here would
      // shift every reported row number above the gap.
      skip_empty_lines: false,
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

export function decodeText(bytes: Buffer): string {
  if (bytes.length > 1 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.toString("utf16le", 2);
  if (bytes.length > 1 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return bytes.subarray(2).swap16().toString("utf16le");
  }
  return bytes.toString("utf8");
}

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
