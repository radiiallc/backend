/**
 * xlsx-import — pull the cell grid out of an .xlsx workbook so the inventory
 * importer can treat a spreadsheet exactly like a CSV.
 *
 * Jennifer works in Excel and sends .xlsx (the 7-30 test upload is one). Telling
 * her to "save as CSV first" adds a manual step to every import, and Excel's CSV
 * export is where quoting/encoding damage happens — so read the workbook itself.
 *
 * Deliberately dependency-free: an .xlsx IS a ZIP of XML parts, and Node's zlib
 * already inflates. We walk the ZIP central directory, inflate only the parts we
 * need (workbook + rels + sharedStrings + styles + one worksheet) and scan the
 * cell XML, which Excel writes in a very regular machine-generated form.
 *
 * Every value comes back as a STRING — the same shape csv-parse produces — so
 * the alias matching, number/money cleaning and validation in csv-import are
 * shared by both paths and can't drift apart.
 */

import { inflateRawSync } from "node:zlib";

import type { ImsCsvCategory } from "@/contract";

// Thrown for a file we can read but won't: the message is shown to the admin, so
// keep it a plain-English instruction rather than a format detail.
export class WorkbookError extends Error {}

// ── ZIP container ────────────────────────────────────────────────────────────

const SIG_EOCD = 0x06054b50; // end of central directory
const SIG_CENTRAL = 0x02014b50; // central directory file header

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

/** "PK\x03\x04" — every .xlsx / .xlsm starts here (so does .zip and .docx). */
export function isZipArchive(bytes: Buffer): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** OLE2 compound-file magic — the pre-2007 binary .xls (and .doc/.ppt). */
export function isLegacyXls(bytes: Buffer): boolean {
  return bytes.length > 8 && bytes.readUInt32LE(0) === 0xe011cfd0 && bytes.readUInt32LE(4) === 0xe11ab1a1;
}

// The EOCD sits at the very end, after an optional ≤64KB comment — scan back for
// its signature rather than assuming a comment-less archive.
function findEndOfCentralDirectory(buf: Buffer): number {
  const floor = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

// Index the archive without inflating anything: the central directory lists every
// entry, so we can locate one part by name and decompress it alone.
function readDirectory(buf: Buffer): Map<string, ZipEntry> {
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) throw new WorkbookError("that file isn't a readable Excel workbook");
  const count = buf.readUInt16LE(eocd + 10);
  const entries = new Map<string, ZipEntry>();
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) break;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (flags & 0x1) throw new WorkbookError("that workbook is password-protected — remove the password and re-save it");
    if (localOffset === 0xffffffff) throw new WorkbookError("that workbook uses ZIP64 (unusually large) — re-save it as .xlsx or .csv");
    entries.set(name, { name, method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// The local header repeats the name and carries its own extra field, whose length
// often differs from the central copy — so the data offset must be read here.
function readPart(buf: Buffer, entries: Map<string, ZipEntry>, name: string): string | null {
  const e = entries.get(name);
  if (!e) return null;
  const nameLen = buf.readUInt16LE(e.localOffset + 26);
  const extraLen = buf.readUInt16LE(e.localOffset + 28);
  const start = e.localOffset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.compressedSize);
  if (e.method === 0) return raw.toString("utf8"); // stored
  if (e.method === 8) return inflateRawSync(raw).toString("utf8"); // deflate
  throw new WorkbookError(`that workbook uses an unsupported compression method (${e.method})`);
}

// ── XML scanning ─────────────────────────────────────────────────────────────
// Worksheet XML is machine-written and extremely regular, so targeted scanning
// beats pulling in a full parser. Everything below reads element *text*, never
// interprets structure beyond <row>/<c>/<t>.

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[ent] ?? whole;
  });
}

// Concatenate every <t> in a fragment. Rich text splits one value across several
// <r><t> runs, so joining them is what reassembles the cell the user sees.
function textOf(fragment: string): string {
  let out = "";
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment))) out += decodeXml(m[1]);
  return out;
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
}

function readSharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  // <rPh> holds furigana for Japanese entry — its <t> is not part of the value.
  const cleaned = xml.replace(/<rPh[\s\S]*?<\/rPh>/g, "");
  const out: string[] = [];
  const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si(?:\s[^>]*)?\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned))) out.push(m[1] === undefined ? "" : textOf(m[1]));
  return out;
}

// ── number formats ───────────────────────────────────────────────────────────
// A cell's raw <v> is the underlying number, not what Excel draws. Two formats
// change the *value* rather than its decoration and must be honoured:
//   • percent — "61.8%" is stored as 0.618, and Depth % / Table % are imported
//     fields, so ignoring this would divide those grades by 100.
//   • date — stored as a day serial; rendered as a serial it reads as garbage.
// Everything else (currency, thousands, decimals) is decoration over a number we
// already want raw, which is why only these two are decoded.

const BUILTIN_PERCENT = new Set([9, 10]);
const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

interface StyleFormats {
  percent: Set<number>; // cellXf index → percent
  date: Set<number>; // cellXf index → date/time
}

// Literal text inside a format code is quoted or backslash-escaped; strip it
// before looking for format tokens so a code like "\"%\"0.00" isn't read as a
// percentage and `"May"` isn't read as a month.
function stripFormatLiterals(code: string): string {
  return code.replace(/"[^"]*"/g, "").replace(/\\./g, "").replace(/\[[^\]]*\]/g, "");
}

function readStyleFormats(xml: string | null): StyleFormats {
  const percent = new Set<number>();
  const date = new Set<number>();
  if (!xml) return { percent, date };

  const custom = new Map<number, string>();
  const fmtRe = /<numFmt\s[^>]*\/>/g;
  let f: RegExpExecArray | null;
  while ((f = fmtRe.exec(xml))) {
    const id = Number(attr(f[0], "numFmtId"));
    const code = attr(f[0], "formatCode");
    if (Number.isFinite(id) && code != null) custom.set(id, decodeXml(code));
  }

  // Only the cellXfs block maps a cell's s="…" index; cellStyleXfs above it uses
  // the same element name, so scope the scan to that block.
  const block = /<cellXfs[\s\S]*?<\/cellXfs>/.exec(xml)?.[0] ?? "";
  const xfRe = /<xf\b[^>]*(?:\/>|>)/g;
  let i = 0;
  let x: RegExpExecArray | null;
  while ((x = xfRe.exec(block))) {
    const id = Number(attr(x[0], "numFmtId") ?? "0");
    const code = custom.get(id);
    const bare = code ? stripFormatLiterals(code) : "";
    if (BUILTIN_PERCENT.has(id) || bare.includes("%")) percent.add(i);
    else if (BUILTIN_DATE.has(id) || (code !== undefined && /[ymdhs]/i.test(bare))) date.add(i);
    i++;
  }
  return { percent, date };
}

// Excel day serial → ISO. The 1900 system counts from 1899-12-30 because Excel
// keeps Lotus's phantom 29 Feb 1900; the 1904 system (older Mac files) counts
// from 1904-01-01. A whole serial renders as a date, a fractional one keeps time.
function serialToIso(serial: number, epoch1904: boolean): string {
  const base = Date.UTC(epoch1904 ? 1904 : 1899, epoch1904 ? 0 : 11, epoch1904 ? 1 : 30);
  const ms = Math.round(serial * 86400000);
  const d = new Date(base + ms);
  if (!Number.isFinite(d.getTime())) return String(serial);
  const iso = d.toISOString();
  return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
}

// ── sheet grid ───────────────────────────────────────────────────────────────

// "BC" → 54 (0-based). A cell's r="BC7" is the only reliable column position:
// Excel omits empty cells entirely, so the Nth <c> is not the Nth column.
function columnIndex(ref: string): number {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

function sheetToRecords(
  xml: string,
  shared: string[],
  styles: StyleFormats,
  epoch1904: boolean
): string[][] {
  const records: string[][] = [];
  const rowRe = /<row\b[^>]*(?:\/>|>([\s\S]*?)<\/row>)/g;
  let r: RegExpExecArray | null;
  while ((r = rowRe.exec(xml))) {
    const body = r[1];
    if (!body) continue; // <row .../> — no cells
    const cells = new Map<number, string>();
    let widest = -1;
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let c: RegExpExecArray | null;
    while ((c = cellRe.exec(body))) {
      const tag = c[1];
      const inner = c[2] ?? "";
      const ref = attr(tag, "r");
      const col = ref ? columnIndex(ref) : widest + 1;
      const type = attr(tag, "t") ?? "n";
      let value: string;
      if (type === "inlineStr") {
        value = textOf(inner);
      } else if (type === "s") {
        const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "";
        value = shared[Number(raw)] ?? "";
      } else if (type === "e") {
        value = ""; // #N/A, #REF! — an error is not data
      } else {
        const raw = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "");
        if (type === "str" || type === "d") {
          value = raw;
        } else if (type === "b") {
          value = raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : raw;
        } else {
          const n = Number(raw);
          const style = Number(attr(tag, "s") ?? "-1");
          if (raw !== "" && Number.isFinite(n) && styles.percent.has(style)) value = String(n * 100);
          else if (raw !== "" && Number.isFinite(n) && styles.date.has(style)) value = serialToIso(n, epoch1904);
          else value = raw;
        }
      }
      if (col >= 0) {
        cells.set(col, value);
        if (col > widest) widest = col;
      }
    }
    // Fill the gaps Excel left out so column positions line up with the header.
    const row: string[] = [];
    for (let i = 0; i <= widest; i++) row.push(cells.get(i) ?? "");
    records.push(row);
  }
  return records;
}

// ── workbook ─────────────────────────────────────────────────────────────────

interface SheetRef {
  name: string;
  path: string;
}

function readSheetRefs(buf: Buffer, entries: Map<string, ZipEntry>): SheetRef[] {
  const workbook = readPart(buf, entries, "xl/workbook.xml");
  if (!workbook) throw new WorkbookError("that file isn't a readable Excel workbook (no workbook part)");
  const rels = readPart(buf, entries, "xl/_rels/workbook.xml.rels") ?? "";

  const targets = new Map<string, string>();
  const relRe = /<Relationship\b[^>]*\/>/g;
  let rel: RegExpExecArray | null;
  while ((rel = relRe.exec(rels))) {
    const id = attr(rel[0], "Id");
    const target = attr(rel[0], "Target");
    if (!id || !target) continue;
    // Targets are relative to xl/ unless absolute ("/xl/worksheets/sheet1.xml").
    targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`);
  }

  const refs: SheetRef[] = [];
  const sheetRe = /<sheet\b[^>]*\/>/g;
  let s: RegExpExecArray | null;
  let fallbackIndex = 0;
  while ((s = sheetRe.exec(workbook))) {
    fallbackIndex++;
    const name = decodeXml(attr(s[0], "name") ?? `Sheet${fallbackIndex}`);
    const rid = attr(s[0], "r:id") ?? attr(s[0], "id");
    const path = (rid && targets.get(rid)) || `xl/worksheets/sheet${fallbackIndex}.xml`;
    if (entries.has(path)) refs.push({ name, path });
  }
  if (refs.length === 0) throw new WorkbookError("that workbook has no readable sheets");
  return refs;
}

// Jennifer's template is one tab per category, so a 4-tab workbook must not be
// read blindly from the first sheet — match the chosen category by tab name. A
// name match is taken as intent and wins even if that tab is empty (better to
// say "the Gems tab is empty" than to quietly import the Diamonds tab as gems);
// only when nothing matches do we fall through to the first tab with data. The
// caller shows which tab was read, so a wrong guess is visible in the preview.
const SHEET_HINTS: Record<ImsCsvCategory, RegExp> = {
  diamonds: /diamond/i,
  gems: /\bgems?\b|gemstone|colou?red|sapphire|ruby|emerald/i,
  jewelry: /jewel|jewellery/i,
  other: /other|material|finding|misc/i
};

export interface WorkbookGrid {
  sheetName: string;
  records: string[][];
}

/**
 * Read one sheet of an .xlsx as a CSV-shaped grid: `records[0]` is the header
 * row, the rest are data rows, every cell a string.
 */
export function readWorkbookGrid(bytes: Buffer, category: ImsCsvCategory): WorkbookGrid {
  const entries = readDirectory(bytes);
  const workbookXml = readPart(bytes, entries, "xl/workbook.xml") ?? "";
  const epoch1904 = /date1904="(1|true)"/i.test(workbookXml);
  const shared = readSharedStrings(readPart(bytes, entries, "xl/sharedStrings.xml"));
  const styles = readStyleFormats(readPart(bytes, entries, "xl/styles.xml"));
  const refs = readSheetRefs(bytes, entries);

  const read = (ref: SheetRef): WorkbookGrid => {
    const xml = readPart(bytes, entries, ref.path);
    if (!xml) throw new WorkbookError(`could not read the "${ref.name}" tab`);
    return { sheetName: ref.name, records: sheetToRecords(xml, shared, styles, epoch1904) };
  };

  const named = refs.find((ref) => SHEET_HINTS[category].test(ref.name));
  if (named) return read(named);
  for (const ref of refs) {
    const grid = read(ref);
    if (grid.records.length >= 2) return grid;
  }
  return read(refs[0]);
}
