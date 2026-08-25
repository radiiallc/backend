const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584
];

const HELVETICA_BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584
];

const EXTRA_WIDTHS: Record<number, [number, number]> = {
  0x85: [1000, 1000],
  0x91: [222, 238],
  0x92: [222, 238],
  0x93: [333, 500],
  0x94: [333, 500],
  0x95: [350, 350],
  0x96: [556, 556],
  0x97: [1000, 1000],
  0xa0: [278, 278],
  0xa9: [737, 737],
  0xb0: [400, 400],
  0xb7: [278, 278],
  0xd7: [584, 584]
};

const UNICODE_TO_WINANSI: Record<string, number> = {
  "‘": 0x91,
  "’": 0x92,
  "“": 0x93,
  "”": 0x94,
  "•": 0x95,
  "–": 0x96,
  "—": 0x97,
  "…": 0x85,
  " ": 0xa0,
  "©": 0xa9,
  "°": 0xb0,
  "·": 0xb7,
  "×": 0xd7
};

const ELLIPSIS = String.fromCharCode(0x85);
const DEFAULT_WIDTH = 556;

export const PAGE_PORTRAIT = { width: 612, height: 792 };
export const PAGE_LANDSCAPE = { width: 792, height: 612 };

/**
 * Encodes text to WinAnsi bytes, held in a latin1-safe JS string. Characters we
 * have no glyph for become "?" rather than silently producing a corrupt stream.
 */
function toWinAnsi(text: string): string {
  let out = "";
  for (const char of text) {
    const mapped = UNICODE_TO_WINANSI[char];
    if (mapped !== undefined) {
      out += String.fromCharCode(mapped);
      continue;
    }
    const code = char.codePointAt(0) ?? 63;
    if (code === 9) {
      out += "  ";
    } else if (code < 32) {
      out += " ";
    } else if (code <= 0xff) {
      out += String.fromCharCode(code);
    } else {
      out += "?";
    }
  }
  return out;
}

function glyphWidth(code: number, bold: boolean): number {
  if (code >= 32 && code <= 126) {
    return bold ? HELVETICA_BOLD_WIDTHS[code - 32] : HELVETICA_WIDTHS[code - 32];
  }
  const extra = EXTRA_WIDTHS[code];
  if (extra) return bold ? extra[1] : extra[0];
  return DEFAULT_WIDTH;
}

/** Width of already-encoded WinAnsi text, in points. */
function encodedWidth(encoded: string, size: number, bold: boolean): number {
  let total = 0;
  for (let i = 0; i < encoded.length; i += 1) {
    total += glyphWidth(encoded.charCodeAt(i), bold);
  }
  return (total * size) / 1000;
}

export function measureText(text: string, size: number, bold = false): number {
  return encodedWidth(toWinAnsi(text), size, bold);
}

function truncateEncoded(encoded: string, size: number, bold: boolean, maxWidth: number): string {
  if (encodedWidth(encoded, size, bold) <= maxWidth) return encoded;
  const ellipsisWidth = encodedWidth(ELLIPSIS, size, bold);
  let cut = encoded.length;
  while (cut > 0) {
    cut -= 1;
    const candidate = encoded.slice(0, cut);
    if (encodedWidth(candidate, size, bold) + ellipsisWidth <= maxWidth) {
      return candidate + ELLIPSIS;
    }
  }
  return "";
}

function escapePdfString(encoded: string): string {
  return encoded.replace(/[\\()]/g, (m) => `\\${m}`);
}

export type TextOptions = {
  size?: number;
  bold?: boolean;
  align?: "left" | "right" | "center";
  gray?: number;
  maxWidth?: number;
};

export type LineOptions = {
  width?: number;
  gray?: number;
};

type Page = {
  width: number;
  height: number;
  ops: string[];
};

/**
 * Minimal PDF 1.4 writer built on the standard-14 Helvetica faces, so nothing
 * has to be embedded and no dependency is needed. Coordinates are top-left
 * origin (y grows downward) and converted to PDF space on write.
 */
export class PdfDocument {
  private readonly pages: Page[] = [];
  private page: Page | null = null;

  addPage(landscape = false): void {
    const size = landscape ? PAGE_LANDSCAPE : PAGE_PORTRAIT;
    this.page = { width: size.width, height: size.height, ops: [] };
    this.pages.push(this.page);
  }

  private current(): Page {
    if (!this.page) this.addPage();
    return this.page as Page;
  }

  get pageWidth(): number {
    return this.current().width;
  }

  get pageHeight(): number {
    return this.current().height;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  text(value: string, x: number, y: number, options: TextOptions = {}): void {
    const size = options.size ?? 9;
    const bold = options.bold ?? false;
    const gray = options.gray ?? 0;
    let encoded = toWinAnsi(value);
    if (options.maxWidth !== undefined) {
      encoded = truncateEncoded(encoded, size, bold, options.maxWidth);
    }
    if (encoded.length === 0) return;

    let drawX = x;
    if (options.align === "right" || options.align === "center") {
      const width = encodedWidth(encoded, size, bold);
      drawX = options.align === "right" ? x - width : x - width / 2;
    }

    const page = this.current();
    const pdfY = page.height - y;
    page.ops.push(
      `q ${gray.toFixed(3)} g BT /${bold ? "F2" : "F1"} ${size} Tf ` +
        `${drawX.toFixed(2)} ${pdfY.toFixed(2)} Td (${escapePdfString(encoded)}) Tj ET Q`
    );
  }

  line(x1: number, y1: number, x2: number, y2: number, options: LineOptions = {}): void {
    const page = this.current();
    const width = options.width ?? 0.5;
    const gray = options.gray ?? 0;
    page.ops.push(
      `q ${gray.toFixed(3)} G ${width} w ${x1.toFixed(2)} ${(page.height - y1).toFixed(2)} m ` +
        `${x2.toFixed(2)} ${(page.height - y2).toFixed(2)} l S Q`
    );
  }

  toBuffer(): Buffer {
    if (this.pages.length === 0) this.addPage();

    const objects: string[] = [];
    const pageObjectStart = 5;
    const kids = this.pages
      .map((_, i) => `${pageObjectStart + i * 2} 0 R`)
      .join(" ");

    objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${this.pages.length} >>`;
    objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
    objects[4] =
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";

    this.pages.forEach((page, i) => {
      const pageObj = pageObjectStart + i * 2;
      const contentObj = pageObj + 1;
      const stream = page.ops.join("\n");
      objects[pageObj] =
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObj} 0 R >>`;
      objects[contentObj] =
        `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
    });

    const count = objects.length;
    let body = "%PDF-1.4\n";
    const offsets: number[] = [];
    for (let i = 1; i < count; i += 1) {
      offsets[i] = Buffer.byteLength(body, "latin1");
      body += `${i} 0 obj\n${objects[i]}\nendobj\n`;
    }

    const xrefOffset = Buffer.byteLength(body, "latin1");
    let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (let i = 1; i < count; i += 1) {
      xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
    }
    const trailer = `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

    return Buffer.from(body + xref + trailer, "latin1");
  }
}

export type TableColumn = {
  header: string;
  width: number;
  align?: "left" | "right";
};

export type TableRow = string[];

/**
 * Draws a header row plus body rows, paginating when the page runs out. Returns
 * the y position just below the last row drawn.
 */
export function drawTable(
  doc: PdfDocument,
  columns: TableColumn[],
  rows: TableRow[],
  options: {
    x: number;
    y: number;
    bottomMargin: number;
    rowHeight?: number;
    fontSize?: number;
    landscape: boolean;
    onNewPage?: () => number;
  }
): number {
  const rowHeight = options.rowHeight ?? 14;
  const fontSize = options.fontSize ?? 8;
  let y = options.y;

  const drawHeader = () => {
    let x = options.x;
    for (const col of columns) {
      const anchor = col.align === "right" ? x + col.width : x;
      doc.text(col.header, anchor, y, {
        size: fontSize,
        gray: 0.42,
        align: col.align ?? "left",
        maxWidth: col.width - 4
      });
      x += col.width;
    }
    y += 4;
    const totalWidth = columns.reduce((sum, c) => sum + c.width, 0);
    doc.line(options.x, y, options.x + totalWidth, y, { width: 0.7, gray: 0.55 });
    y += rowHeight;
  };

  drawHeader();

  for (const row of rows) {
    if (y > options.bottomMargin) {
      doc.addPage(options.landscape);
      y = options.onNewPage ? options.onNewPage() : 56;
      drawHeader();
    }
    let x = options.x;
    row.forEach((cell, i) => {
      const col = columns[i];
      if (!col) return;
      const anchor = col.align === "right" ? x + col.width : x;
      doc.text(cell, anchor, y, {
        size: fontSize,
        align: col.align ?? "left",
        maxWidth: col.width - 4
      });
      x += col.width;
    });
    y += rowHeight;
  }

  return y;
}
