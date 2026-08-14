
import { inflateRawSync } from "node:zlib";

import type { ImsCsvCategory } from "@/contract";

export class WorkbookError extends Error {}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

export function isZipArchive(bytes: Buffer): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export function isLegacyXls(bytes: Buffer): boolean {
  return bytes.length > 8 && bytes.readUInt32LE(0) === 0xe011cfd0 && bytes.readUInt32LE(4) === 0xe11ab1a1;
}

function findEndOfCentralDirectory(buf: Buffer): number {
  const floor = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

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

function readPart(buf: Buffer, entries: Map<string, ZipEntry>, name: string): string | null {
  const e = entries.get(name);
  if (!e) return null;
  const nameLen = buf.readUInt16LE(e.localOffset + 26);
  const extraLen = buf.readUInt16LE(e.localOffset + 28);
  const start = e.localOffset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.compressedSize);
  if (e.method === 0) return raw.toString("utf8");
  if (e.method === 8) return inflateRawSync(raw).toString("utf8");
  throw new WorkbookError(`that workbook uses an unsupported compression method (${e.method})`);
}

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
  const cleaned = xml.replace(/<rPh[\s\S]*?<\/rPh>/g, "");
  const out: string[] = [];
  const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si(?:\s[^>]*)?\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned))) out.push(m[1] === undefined ? "" : textOf(m[1]));
  return out;
}

const BUILTIN_PERCENT = new Set([9, 10]);
const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

interface StyleFormats {
  percent: Set<number>;
  date: Set<number>;
}

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

function serialToIso(serial: number, epoch1904: boolean): string {
  const base = Date.UTC(epoch1904 ? 1904 : 1899, epoch1904 ? 0 : 11, epoch1904 ? 1 : 30);
  const ms = Math.round(serial * 86400000);
  const d = new Date(base + ms);
  if (!Number.isFinite(d.getTime())) return String(serial);
  const iso = d.toISOString();
  return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
}

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
    if (!body) continue;
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
        value = "";
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
    const row: string[] = [];
    for (let i = 0; i <= widest; i++) row.push(cells.get(i) ?? "");
    records.push(row);
  }
  return records;
}

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
