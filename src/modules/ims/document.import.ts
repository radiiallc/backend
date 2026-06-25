import { z } from "zod";

import {
  InboundDocumentTypeSchema,
  InboundLineSchema,
  ItemTypeSchema,
  type CreateInboundDocumentBody,
  type InboundLineInput,
  type ItemTypeValue
} from "@/contract";

import { createInboundDocument } from "./document.service";

// ────────────────────────────────────────────────────────────────────────────
// Bulk CSV import for inbound documents (§4.5). One uploaded CSV → one inbound
// document built from N validated rows. The whole import is ALL-OR-NOTHING
// (gate §6.13): every row is validated up-front and reported by row number; only
// if all rows pass do we hand the assembled lines to createInboundDocument,
// whose single transaction commits them together (0 items on any later failure).
// Also serves the initial Fantasy stock load (H5).
//
// ⚠️ COLUMN DEFINITIONS ARE PROVISIONAL. The exact per-type template columns are
// a 🔴 blocker on Jennifer (IMPLEMENTATION_PLAN §H4.5 / blockers table). The sets
// below are derived from the locked field-map so the framework — parsing,
// per-row validation, atomic commit, template download — is complete and
// testable now; swap the COLUMN_SPECS arrays when Jennifer's column list lands.
// Cert lookup is deliberately NOT triggered on import (§4.5) — cert numbers are
// stored as-is.
// ────────────────────────────────────────────────────────────────────────────

type Group = "item" | "stone" | "jewelry" | "other" | "line";
type CellKind = "string" | "number" | "int" | "enum";

type ColumnSpec = {
  col: string; // CSV header
  group: Group;
  key: string; // target field within the group
  kind: CellKind;
  enumVals?: readonly string[];
};

const LINE_COLUMNS: ColumnSpec[] = [
  { col: "quantity", group: "line", key: "quantity", kind: "int" },
  { col: "caratWeight", group: "line", key: "caratWeight", kind: "number" },
  { col: "unitPrice", group: "line", key: "unitPrice", kind: "number" },
  { col: "totalPrice", group: "line", key: "totalPrice", kind: "number" },
  { col: "discountAmount", group: "line", key: "discountAmount", kind: "number" },
  { col: "notes", group: "line", key: "notes", kind: "string" }
];

const STONE_COLUMNS: ColumnSpec[] = [
  { col: "sku", group: "item", key: "sku", kind: "string" },
  { col: "itemSubtype", group: "item", key: "itemSubtype", kind: "enum", enumVals: ["SINGLE", "PAIR", "PARCEL"] },
  { col: "gemType", group: "stone", key: "gemType", kind: "string" },
  { col: "shape", group: "stone", key: "shape", kind: "string" },
  { col: "weightCt", group: "stone", key: "weightCt", kind: "number" },
  { col: "parcelQuantity", group: "stone", key: "quantity", kind: "int" },
  { col: "color", group: "stone", key: "color", kind: "string" },
  { col: "clarity", group: "stone", key: "clarity", kind: "string" },
  { col: "cutGrade", group: "stone", key: "cutGrade", kind: "string" },
  { col: "polish", group: "stone", key: "polish", kind: "string" },
  { col: "symmetry", group: "stone", key: "symmetry", kind: "string" },
  { col: "fluorescence", group: "stone", key: "fluorescence", kind: "string" },
  { col: "lengthMm", group: "stone", key: "lengthMm", kind: "number" },
  { col: "widthMm", group: "stone", key: "widthMm", kind: "number" },
  { col: "heightMm", group: "stone", key: "heightMm", kind: "number" },
  { col: "depthPct", group: "stone", key: "depthPct", kind: "number" },
  { col: "tablePct", group: "stone", key: "tablePct", kind: "number" },
  { col: "girdle", group: "stone", key: "girdle", kind: "string" },
  { col: "lab", group: "stone", key: "lab", kind: "enum", enumVals: ["GIA", "IGI", "NONE"] },
  { col: "certNumber", group: "stone", key: "certNumber", kind: "string" },
  { col: "naturalOrLab", group: "stone", key: "naturalOrLab", kind: "enum", enumVals: ["NATURAL", "LAB"] },
  { col: "origin", group: "stone", key: "origin", kind: "string" },
  { col: "treatment", group: "stone", key: "treatment", kind: "string" },
  { col: "wholesalePricePerCt", group: "stone", key: "wholesalePricePerCt", kind: "number" },
  { col: "costPerCt", group: "stone", key: "costPerCt", kind: "number" },
  ...LINE_COLUMNS
];

const JEWELRY_COLUMNS: ColumnSpec[] = [
  { col: "sku", group: "item", key: "sku", kind: "string" },
  { col: "brand", group: "jewelry", key: "brand", kind: "string" },
  { col: "jewelryItemType", group: "jewelry", key: "jewelryItemType", kind: "string" },
  { col: "metal", group: "jewelry", key: "metal", kind: "string" },
  { col: "ringSize", group: "jewelry", key: "ringSize", kind: "string" },
  { col: "lengthMm", group: "jewelry", key: "lengthMm", kind: "number" },
  { col: "productionCost", group: "jewelry", key: "productionCost", kind: "number" },
  { col: "wholesalePrice", group: "jewelry", key: "wholesalePrice", kind: "number" },
  { col: "retailPrice", group: "jewelry", key: "retailPrice", kind: "number" },
  { col: "description", group: "jewelry", key: "description", kind: "string" },
  { col: "certNumber", group: "jewelry", key: "certNumber", kind: "string" },
  ...LINE_COLUMNS
];

const OTHER_COLUMNS: ColumnSpec[] = [
  { col: "sku", group: "item", key: "sku", kind: "string" },
  { col: "subtype", group: "other", key: "subtype", kind: "enum", enumVals: ["BRACELET_MOUNTING", "EARRING_MOUNTING", "EARRING_BACK", "EARRING_POST", "CLASP", "OTHER"] },
  { col: "metalType", group: "other", key: "metalType", kind: "string" },
  { col: "lengthMm", group: "other", key: "lengthMm", kind: "number" },
  { col: "widthMm", group: "other", key: "widthMm", kind: "number" },
  { col: "weightGrams", group: "other", key: "weightGrams", kind: "number" },
  { col: "materialQuantity", group: "other", key: "quantity", kind: "int" },
  { col: "description", group: "other", key: "description", kind: "string" },
  { col: "cost", group: "other", key: "cost", kind: "number" },
  ...LINE_COLUMNS
];

function columnsFor(itemType: ItemTypeValue): ColumnSpec[] {
  if (itemType === "JEWELRY") return JEWELRY_COLUMNS;
  if (itemType === "OTHER_MATERIAL") return OTHER_COLUMNS;
  return STONE_COLUMNS;
}

// ── Minimal RFC-4180-ish CSV parser (no dep) ──────────────────────────────────
// Handles quoted fields, embedded commas/newlines, and "" escapes. Returns rows
// of raw string cells; the first row is the header.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  // Strip a UTF-8 BOM if present (Excel exports one).
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch === "\r") {
      // swallow; the \n handles the row break (CRLF) — a lone CR also breaks
      if (src[i + 1] !== "\n") {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
      }
    } else {
      cell += ch;
    }
  }
  // Flush the last cell/row unless the input ended on a clean newline.
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  // Drop fully-empty rows (e.g. a trailing blank line).
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

// ── Template download ──────────────────────────────────────────────────────────
const INBOUND_FILENAME: Record<string, string> = {
  BILL_IN: "bill-in",
  MEMO_IN: "memo-in",
  BRAND_INVENTORY_IN: "brand-inventory-in"
};

export function buildInboundTemplate(
  typeStr: string,
  itemTypeStr?: string
): { filename: string; csv: string } | null {
  const type = InboundDocumentTypeSchema.safeParse(typeStr);
  if (!type.success) return null;
  const itemType = ItemTypeSchema.safeParse(itemTypeStr ?? "STONE");
  const it: ItemTypeValue = itemType.success ? itemType.data : "STONE";

  const header = columnsFor(it).map((c) => c.col).join(",");
  const slug = `${INBOUND_FILENAME[type.data]}-${it.toLowerCase()}`;
  return { filename: `${slug}-template.csv`, csv: `${header}\r\n` };
}

// ── Import ─────────────────────────────────────────────────────────────────────
const ImportEnvelopeSchema = z.object({
  type: InboundDocumentTypeSchema,
  itemType: ItemTypeSchema.optional(),
  vendorId: z.string().optional(),
  clientId: z.string().optional(),
  externalReference: z.string().trim().nullable().optional(),
  issueDate: z.string().datetime().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  projectJob: z.string().trim().nullable().optional(),
  discountAmount: z.number().nullable().optional(),
  notes: z.string().trim().nullable().optional(),
  csv: z.string().min(1, "csv is required")
});

export type RowError = { row: number; messages: string[] };

export type ImportResult =
  | {
      ok: true;
      id: string;
      documentNumber: string | null;
      createdItemIds: string[];
      rowCount: number;
    }
  | { ok: false; error: string; rowErrors?: RowError[] };

function parseCell(spec: ColumnSpec, raw: string): { value?: unknown; error?: string } {
  const v = raw.trim();
  if (v === "") return {}; // empty → field omitted
  switch (spec.kind) {
    case "string":
      return { value: v };
    case "number": {
      const n = Number(v);
      return Number.isFinite(n) ? { value: n } : { error: `${spec.col}: "${v}" is not a number` };
    }
    case "int": {
      const n = Number(v);
      return Number.isInteger(n) ? { value: n } : { error: `${spec.col}: "${v}" is not an integer` };
    }
    case "enum": {
      const up = v.toUpperCase();
      return spec.enumVals?.includes(up)
        ? { value: up }
        : { error: `${spec.col}: "${v}" must be one of ${spec.enumVals?.join(" / ")}` };
    }
  }
}

// Build one InboundLineInput from a CSV row; collect per-cell errors.
function mapRow(
  specs: ColumnSpec[],
  headerIndex: Map<string, number>,
  cells: string[],
  itemType: ItemTypeValue
): { line?: InboundLineInput; errors: string[] } {
  const errors: string[] = [];
  const groups: Record<Group, Record<string, unknown>> = {
    item: {},
    stone: {},
    jewelry: {},
    other: {},
    line: {}
  };

  for (const spec of specs) {
    const idx = headerIndex.get(spec.col.toLowerCase());
    if (idx === undefined) continue; // column not in the uploaded file → skip
    const { value, error } = parseCell(spec, cells[idx] ?? "");
    if (error) errors.push(error);
    else if (value !== undefined) groups[spec.group][spec.key] = value;
  }

  // Assemble the nested line shape the contract expects.
  const line: Record<string, unknown> = { itemType, ...groups.item, ...groups.line };
  if (Object.keys(groups.stone).length) line.stone = groups.stone;
  if (Object.keys(groups.jewelry).length) line.jewelry = groups.jewelry;
  if (Object.keys(groups.other).length) line.other = groups.other;

  // Final structural validation against the wire schema (catches anything the
  // cell-level checks missed, e.g. an out-of-range enum the parser allowed).
  const parsed = InboundLineSchema.safeParse(line);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`${issue.path.join(".") || "row"}: ${issue.message}`);
    }
  }
  return errors.length ? { errors } : { line: parsed.success ? parsed.data : undefined, errors };
}

export async function importInboundCsv(
  rawBody: unknown,
  actingUserId: string
): Promise<ImportResult> {
  const env = ImportEnvelopeSchema.safeParse(rawBody);
  if (!env.success) {
    return { ok: false, error: "Invalid import request" };
  }
  const body = env.data;
  const itemType: ItemTypeValue = body.itemType ?? "STONE";
  const specs = columnsFor(itemType);

  const grid = parseCsv(body.csv);
  if (grid.length < 2) {
    return { ok: false, error: "CSV has no data rows (expected a header row + at least one row)." };
  }

  const header = grid[0].map((h) => h.trim().toLowerCase());
  const headerIndex = new Map<string, number>();
  header.forEach((h, i) => {
    if (!headerIndex.has(h)) headerIndex.set(h, i);
  });

  const dataRows = grid.slice(1);
  const lines: InboundLineInput[] = [];
  const rowErrors: RowError[] = [];

  dataRows.forEach((cells, i) => {
    const { line, errors } = mapRow(specs, headerIndex, cells, itemType);
    // +2 = 1 (header row) + 1 (1-based) → matches what the user sees in Excel.
    if (errors.length) rowErrors.push({ row: i + 2, messages: errors });
    else if (line) lines.push(line);
  });

  // All-or-nothing: any row error → commit nothing (gate §6.13).
  if (rowErrors.length) {
    return { ok: false, error: `${rowErrors.length} row(s) failed validation.`, rowErrors };
  }

  const docBody: CreateInboundDocumentBody = {
    type: body.type,
    vendorId: body.vendorId,
    clientId: body.clientId,
    externalReference: body.externalReference ?? null,
    issueDate: body.issueDate,
    dueDate: body.dueDate ?? null,
    projectJob: body.projectJob ?? null,
    discountAmount: body.discountAmount ?? null,
    notes: body.notes ?? null,
    lines
  };

  const result = await createInboundDocument(docBody, actingUserId);
  if (!result.ok) return { ok: false, error: result.error };

  return {
    ok: true,
    id: result.id,
    documentNumber: result.documentNumber,
    createdItemIds: result.createdItemIds,
    rowCount: lines.length
  };
}
