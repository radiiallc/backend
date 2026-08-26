/**
 * Bulk-send: turn a spreadsheet of identifiers into outbound document lines.
 *
 * The inbound importer reads rows that DESCRIBE items and creates them. This is
 * the mirror image: the rows NAME items we already hold, so the job is matching,
 * and the interesting output is the rows that did not match. Nothing is written
 * here — the caller shows this to the sender, who fixes their file and re-runs
 * before any document exists.
 *
 * Jennifer's case: RADIIA holds a designer's whole open stock and memos 300+ of
 * those pieces out to one store at a time. She exports the Brand In list, keeps
 * the rows going to that store, and uploads what is left — so the file we get
 * back carries the same columns it went out with, and either identifier
 * (RADIIA's SKU or the designer's style number) has to be enough.
 */
import { prisma } from "@/db";
import type {
  ImsDocumentLineDraw,
  ImsOutboundMatchRow,
  ImsParseOutboundCsvResult,
  ItemStatus
} from "@/contract";
import { parse } from "csv-parse/sync";

import { ALLOWED_SOURCE_STATUS, type OutboundCreateType } from "./documents.constants";
import { decodeText, findHeaderRow, hintAliases, makeGet, normalizeHeader } from "./csv-import";
import { remainingPieces } from "./jewelry-lot";
import { isLegacyXls, isZipArchive, readWorkbookGrid, WorkbookError } from "./xlsx-import";

const SKU_ALIASES = ["radiiasku", "sku", "stock", "radiiastocknumber", "stocknumber"];
const STYLE_ALIASES = ["vendorsku", "stylenumber", "style", "styleno", "designersku", "brandsku"];
const QTY_ALIASES = ["qty", "quantity", "pieces", "pcs", "sendqty", "quantitytosend"];

type MatchCandidate = {
  id: string;
  sku: string;
  itemName: string | null;
  itemType: string;
  itemSubtype: string | null;
  status: ItemStatus;
  jewelry: { quantity: number; remainingQty: number | null } | null;
  stone: { weightCt: unknown; remainingCt: unknown } | null;
};

function fileError(
  docType: OutboundCreateType,
  error: string,
  sheetName: string | null = null
): ImsParseOutboundCsvResult {
  return {
    docType,
    sheetName,
    totalRows: 0,
    okCount: 0,
    errorCount: 1,
    rows: [
      {
        rowNumber: 0,
        reference: null,
        state: "notFound",
        ok: false,
        error,
        inventoryItemId: null,
        sku: null,
        label: null,
        status: null,
        availableQty: null,
        availableCt: null,
        requestedQty: null
      }
    ],
    lines: []
  };
}

function num(raw: string): number | null {
  const cleaned = (raw ?? "").replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Style numbers get typed and re-typed by hand; case and spacing drift. */
function foldRef(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "");
}

function labelOf(c: MatchCandidate): string {
  return c.itemName ?? c.sku;
}

function toDecimal(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

type ReadRows = { records: string[][]; sheetName: string | null };

function readGrid(
  docType: OutboundCreateType,
  csv: string | undefined,
  bytes: Buffer | null
): ReadRows | ImsParseOutboundCsvResult {
  if (csv != null) {
    try {
      return {
        records: parse(csv, {
          skip_empty_lines: false,
          trim: true,
          bom: true,
          relax_column_count: true
        }) as string[][],
        sheetName: null
      };
    } catch (e) {
      const detail = e instanceof Error ? e.message : "could not read the file";
      return fileError(docType, `CSV parse failed: ${detail}`);
    }
  }

  const buf = bytes!;
  if (buf.length === 0) return fileError(docType, "That file is empty.");

  if (isZipArchive(buf)) {
    try {
      // The sheet hint is only a hint — it falls back to the first tab with
      // data, which is what a one-tab export off a document list looks like.
      const grid = readWorkbookGrid(buf, "jewelry");
      return { records: grid.records, sheetName: grid.sheetName };
    } catch (e) {
      if (e instanceof WorkbookError) {
        return fileError(docType, `Could not read that workbook — ${e.message}.`);
      }
      const detail = e instanceof Error ? e.message : "unknown error";
      return fileError(docType, `Excel read failed: ${detail}`);
    }
  }

  if (isLegacyXls(buf)) {
    return fileError(
      docType,
      "That's an old .xls workbook. Open it in Excel and re-save as .xlsx (or .csv), then import again."
    );
  }

  return {
    records: parse(decodeText(buf), {
      skip_empty_lines: false,
      trim: true,
      bom: true,
      relax_column_count: true
    }) as string[][],
    sheetName: null
  };
}

type ParsedRow = { rowNumber: number; sku: string | null; style: string | null; qty: number | null };

export async function parseOutboundUpload(input: {
  docType: OutboundCreateType;
  csv?: string;
  bytes?: Buffer | null;
  brandOwnerId?: string | null;
}): Promise<ImsParseOutboundCsvResult> {
  const { docType } = input;
  const grid = readGrid(docType, input.csv, input.bytes ?? null);
  if ("rows" in grid) return grid;

  const { records, sheetName } = grid;
  const headerRow = records.length ? findHeaderRow(records) : 0;
  if (records.length < headerRow + 2) {
    return fileError(docType, "No data rows found (expected a header row + at least one item).", sheetName);
  }

  const headerIndex = new Map<string, number>();
  records[headerRow].forEach((h, i) => {
    const key = normalizeHeader(h);
    if (key && !headerIndex.has(key)) headerIndex.set(key, i);
    for (const alias of hintAliases(h)) if (!headerIndex.has(alias)) headerIndex.set(alias, i);
  });

  const hasSkuColumn = SKU_ALIASES.some((a) => headerIndex.has(a));
  const hasStyleColumn = STYLE_ALIASES.some((a) => headerIndex.has(a));
  if (!hasSkuColumn && !hasStyleColumn) {
    return fileError(
      docType,
      "No identifier column found. The sheet needs a RADIIA SKU column, or the designer's style number.",
      sheetName
    );
  }

  const parsed: ParsedRow[] = [];
  records.slice(headerRow + 1).forEach((row, i) => {
    if (row.every((c) => (c ?? "").trim() === "")) return;
    const get = makeGet(headerIndex, row);
    const sku = get(SKU_ALIASES) || null;
    const style = get(STYLE_ALIASES) || null;
    // A row that names nothing is spreadsheet residue, not a rejected line.
    if (!sku && !style) return;
    parsed.push({
      // The row number as it appears in their file, header and preamble counted.
      rowNumber: headerRow + i + 2,
      sku,
      style,
      qty: num(get(QTY_ALIASES))
    });
  });

  if (parsed.length === 0) {
    return fileError(docType, "No rows on that sheet named an item to send.", sheetName);
  }

  const skus = [...new Set(parsed.map((r) => r.sku).filter((s): s is string => !!s))];
  const styles = [...new Set(parsed.map((r) => r.style).filter((s): s is string => !!s))];

  const scope = input.brandOwnerId ? { brandOwnerId: input.brandOwnerId } : {};
  const select = {
    id: true,
    sku: true,
    vendorSku: true,
    itemName: true,
    itemType: true,
    itemSubtype: true,
    status: true,
    jewelry: { select: { quantity: true, remainingQty: true } },
    stone: { select: { weightCt: true, remainingCt: true } }
  } as const;

  const [bySkuRows, byStyleExact] = await Promise.all([
    skus.length
      ? prisma.inventoryItem.findMany({ where: { ...scope, sku: { in: skus } }, select })
      : Promise.resolve([]),
    styles.length
      ? prisma.inventoryItem.findMany({ where: { ...scope, vendorSku: { in: styles } }, select })
      : Promise.resolve([])
  ]);

  // An exact `in` uses the vendorSku index and covers every value we ourselves
  // handed out. Only what it misses — a style number someone retyped in a
  // different case — is worth a second, unindexed pass, and by then the list is
  // short. Doing the whole lookup case-insensitively would scan the table for
  // every upload to serve the rare typo.
  const matchedExact = new Set(byStyleExact.map((r) => foldRef(r.vendorSku ?? "")));
  const retyped = styles.filter((s) => !matchedExact.has(foldRef(s)));
  const byStyleFolded = retyped.length
    ? await prisma.inventoryItem.findMany({
        where: {
          ...scope,
          OR: retyped.map((s) => ({ vendorSku: { equals: s, mode: "insensitive" as const } }))
        },
        select
      })
    : [];
  const byStyleRows = [...byStyleExact, ...byStyleFolded];

  // Case-folded so a style number retyped in caps still finds its item.
  const bySku = new Map<string, MatchCandidate[]>();
  for (const r of bySkuRows) {
    const k = foldRef(r.sku);
    bySku.set(k, [...(bySku.get(k) ?? []), r as MatchCandidate]);
  }
  const byStyle = new Map<string, MatchCandidate[]>();
  for (const r of byStyleRows) {
    if (!r.vendorSku) continue;
    const k = foldRef(r.vendorSku);
    byStyle.set(k, [...(byStyle.get(k) ?? []), r as MatchCandidate]);
  }

  const allowed = ALLOWED_SOURCE_STATUS[docType];
  const rows: ImsOutboundMatchRow[] = [];
  const lines: ImsDocumentLineDraw[] = [];
  const claimed = new Map<string, number>();

  for (const r of parsed) {
    const reference = r.sku ?? r.style;
    const base = {
      rowNumber: r.rowNumber,
      reference,
      inventoryItemId: null as string | null,
      sku: null as string | null,
      label: null as string | null,
      status: null as ItemStatus | null,
      availableQty: null as number | null,
      availableCt: null as number | null,
      requestedQty: r.qty
    };

    // The RADIIA SKU is unique, so it wins whenever it is present; the style
    // number is only consulted when it is the sole identifier on the row.
    const hits = (r.sku ? bySku.get(foldRef(r.sku)) : undefined) ?? (r.style ? byStyle.get(foldRef(r.style)) : undefined) ?? [];

    if (hits.length === 0) {
      rows.push({
        ...base,
        state: "notFound",
        ok: false,
        error: `No item found for "${reference}"${input.brandOwnerId ? " in this brand's stock" : ""}.`
      });
      continue;
    }

    if (hits.length > 1) {
      rows.push({
        ...base,
        state: "ambiguous",
        ok: false,
        error: `"${reference}" matches ${hits.length} items (${hits.map((h) => h.sku).join(", ")}) — use the RADIIA SKU to say which.`
      });
      continue;
    }

    const hit = hits[0];
    const filled = {
      ...base,
      inventoryItemId: hit.id,
      sku: hit.sku,
      label: labelOf(hit),
      status: hit.status
    };

    const alreadyOn = claimed.get(hit.id);
    if (alreadyOn !== undefined) {
      rows.push({
        ...filled,
        state: "duplicate",
        ok: false,
        error: `${hit.sku} is already on row ${alreadyOn} — combine them into one row.`
      });
      continue;
    }

    if (!allowed.includes(hit.status)) {
      rows.push({
        ...filled,
        state: "unavailable",
        ok: false,
        error: `${hit.sku} is ${hit.status.toLowerCase().replace(/_/g, " ")}, so it cannot go on a ${docType === "INVOICE" ? "invoice" : "memo"}.`
      });
      continue;
    }

    const isJewelryLot = hit.itemType === "JEWELRY" && hit.jewelry !== null;
    const isParcel = hit.itemSubtype === "PARCEL" && hit.stone !== null;
    const availableQty = isJewelryLot ? remainingPieces(hit.jewelry!) : null;
    const availableCt = isParcel
      ? toDecimal(hit.stone!.remainingCt) ?? toDecimal(hit.stone!.weightCt)
      : null;

    if (r.qty !== null && !Number.isInteger(r.qty)) {
      rows.push({
        ...filled,
        availableQty,
        availableCt,
        state: "badQuantity",
        ok: false,
        error: `${hit.sku}: a piece count must be a whole number, got ${r.qty}.`
      });
      continue;
    }
    if (r.qty !== null && r.qty <= 0) {
      rows.push({
        ...filled,
        availableQty,
        availableCt,
        state: "badQuantity",
        ok: false,
        error: `${hit.sku}: a piece count must be greater than zero.`
      });
      continue;
    }
    if (r.qty !== null && availableQty !== null && r.qty > availableQty) {
      rows.push({
        ...filled,
        availableQty,
        availableCt,
        state: "badQuantity",
        ok: false,
        error: `${hit.sku}: only ${availableQty} piece(s) remaining, cannot send ${r.qty}.`
      });
      continue;
    }
    // A quantity against something that has no piece balance to draw from would
    // be silently ignored downstream, which reads as "it worked".
    if (r.qty !== null && r.qty > 1 && availableQty === null) {
      rows.push({
        ...filled,
        availableQty,
        availableCt,
        state: "badQuantity",
        ok: false,
        error: `${hit.sku} is a single item — it can only be sent whole, so a quantity of ${r.qty} has no meaning here.`
      });
      continue;
    }

    claimed.set(hit.id, r.rowNumber);
    rows.push({ ...filled, availableQty, availableCt, state: "matched", ok: true, error: null });
    lines.push(
      r.qty !== null && availableQty !== null
        ? { inventoryItemId: hit.id, quantity: r.qty }
        : { inventoryItemId: hit.id }
    );
  }

  const errorCount = rows.filter((r) => !r.ok).length;
  return {
    docType,
    sheetName,
    totalRows: rows.length,
    okCount: rows.length - errorCount,
    errorCount,
    rows,
    lines
  };
}
