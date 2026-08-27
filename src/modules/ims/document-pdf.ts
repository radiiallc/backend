import { Prisma, prisma } from "@/db";

import { stoneColorLabel } from "@/domain";
import { brandLogo } from "@/integrations/pdf/brand-logo";
import {
  drawTable,
  measureText,
  PdfDocument,
  type TableColumn
} from "@/integrations/pdf/pdf-writer";

import { DOC_LABEL, docDirectionOf } from "./documents.constants";

export const COMPANY_NAME = "RADIIA";
export const COMPANY_ADDRESS = "151 West 46th Street, Floor 6, New York, NY 10036";
export const COMPANY_CONTACT = "212.221.3250 | production@radiia.co";

/**
 * Jennifer's #0019 memo declaration, verbatim from the approved mockup. Printed
 * on every Memo Out — it is the consignment contract, not decoration.
 */
export const MEMO_DECLARATION = [
  "All pieces herein consigned are the sole property of RADIIA LLC until full payment has been " +
    "received and cleared. All pieces herein consigned are under “memorandum” status until full " +
    "payment has been received and cleared. All pieces herein consigned are to be returned to " +
    "RADIIA LLC immediately upon request unless already paid for; in that case proof of payment " +
    "is required within 24 hours. Failure to provide proof of payment within 24 hours of demand " +
    "shall be considered admittance of liability and all pieces invoiced herein are to be " +
    "returned within 24 hours of demand to RADIIA LLC.",
  "The acceptance of this memo - be it in a shipment, personal delivery or email, shall be " +
    "legally binding, and the receiver is personally guaranteeing full payment for pieces " +
    "herein consigned to RADIIA LLC."
];

const DOC_PDF_INCLUDE = {
  vendor: { select: { name: true, address: true } },
  client: { select: { name: true, shippingAddress: true } },
  lineItems: {
    orderBy: { createdAt: "asc" },
    include: {
      inventoryItem: {
        include: {
          stone: true,
          jewelry: true,
          material: true,
          brandOwner: { select: { name: true } }
        }
      }
    }
  }
} satisfies Prisma.DocumentInclude;

export type DocForPdf = Prisma.DocumentGetPayload<{ include: typeof DOC_PDF_INCLUDE }>;
type LineForPdf = DocForPdf["lineItems"][number];

const DASH = "—";

function num(value: Prisma.Decimal | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value.toString());
  return Number.isFinite(n) ? n : null;
}

function usd(value: number | null): string {
  if (value === null) return DASH;
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Money with the currency symbol, negatives as -$x.xx — cells and totals alike. */
function money(value: number | null): string {
  if (value === null) return DASH;
  const amount = usd(Math.abs(value));
  return value < 0 ? `-$${amount}` : `$${amount}`;
}

function carats(value: number | null): string {
  if (value === null) return DASH;
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 3 });
}

function longDate(value: Date | null): string {
  if (!value) return DASH;
  return value.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  });
}

/** Greedy word-wrap against the real glyph widths, for paragraph text like the declaration. */
function wrapText(text: string, size: number, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && measureText(candidate, size) > width) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Memo terms as whole days from issue to return-by — the "7" in "Net 7". */
function memoTermDays(doc: DocForPdf): number | null {
  if (!doc.dueDate || !doc.issueDate) return null;
  const days = Math.round((doc.dueDate.getTime() - doc.issueDate.getTime()) / 86_400_000);
  return days > 0 ? days : null;
}

/** Blank, "NONE" and empty strings all render as an em dash, matching the on-screen template. */
function orDash(value: string | null | undefined): string {
  if (!value) return DASH;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toUpperCase() === "NONE") return DASH;
  return trimmed;
}

type StoneRow = {
  kind: "stone";
  sku: string;
  stoneType: string;
  shape: string;
  qtyFmt: string;
  caratFmt: string;
  color: string;
  clarity: string;
  cut: string;
  measurements: string;
  lab: string;
  cert: string;
  clientRef: string;
  pricePerCtFmt: string;
  amountFmt: string;
  amount: number;
  weightCt: number;
  qty: number;
};

type PieceRow = {
  kind: "piece";
  sku: string;
  brand: string;
  itemType: string;
  metal: string;
  lengthFmt: string;
  sizeFmt: string;
  qtyFmt: string;
  clientRef: string;
  amountFmt: string;
  amount: number;
  qty: number;
};

type DocRow = StoneRow | PieceRow;

function buildRow(line: LineForPdf): DocRow {
  const item = line.inventoryItem;
  const amount = num(line.totalPrice) ?? 0;
  const clientRef = orDash(line.clientReference);
  const sku = item.sku || DASH;
  // A weight-only parcel draw records no piece count; the column must show a
  // dash, never a defaulted 1.
  const qty = line.quantity;
  const qtyFmt = qty !== null ? String(qty) : DASH;

  if (item.stone) {
    const stone = item.stone;
    const naturalOrLab =
      stone.naturalOrLab === "LAB" ? "Lab" : stone.naturalOrLab === "NATURAL" ? "Natural" : "";
    const gemType = stone.gemType?.trim() || "Stone";
    const stoneType =
      gemType === "Diamond" ? `${naturalOrLab ? `${naturalOrLab} ` : ""}Diamond` : gemType;

    // The line's carat weight is the slice this document actually moved, which
    // differs from the lot weight once a parcel has been partially drawn.
    const weightCt = num(line.caratWeight) ?? num(stone.weightCt) ?? 0;
    const measurements =
      [num(stone.lengthMm), num(stone.widthMm), num(stone.heightMm)]
        .filter((v): v is number => v !== null)
        .join(" × ") || DASH;

    return {
      kind: "stone",
      sku,
      stoneType,
      shape: orDash(stone.shape),
      qtyFmt,
      caratFmt: weightCt ? carats(weightCt) : DASH,
      color: orDash(stoneColorLabel(stone)),
      clarity: orDash(stone.clarity),
      cut: orDash(stone.cutGrade),
      measurements,
      lab: orDash(stone.lab),
      cert: orDash(stone.certNumber),
      clientRef,
      pricePerCtFmt: weightCt > 0 ? money(amount / weightCt) : DASH,
      amountFmt: money(amount),
      amount,
      weightCt,
      qty: qty ?? 0
    };
  }

  const jewelry = item.jewelry;
  const material = item.material;
  const itemType =
    jewelry?.jewelryItemType?.trim() ||
    material?.description?.trim() ||
    material?.subtype?.trim() ||
    item.itemName?.trim() ||
    "Item";
  const lengthMm = num(jewelry?.lengthMm ?? material?.lengthMm ?? null);

  return {
    kind: "piece",
    sku,
    brand: orDash(jewelry?.brand || item.brandOwner?.name),
    itemType,
    metal: orDash(jewelry?.metal || material?.metalType),
    lengthFmt: lengthMm !== null ? `${lengthMm} mm` : DASH,
    sizeFmt: orDash(jewelry?.ringSize || material?.size),
    qtyFmt,
    clientRef,
    amountFmt: money(amount),
    amount,
    qty: qty ?? 0
  };
}

export const MARGIN_X = 48;

/** Letterhead mark height in points; its width follows the asset's aspect. */
export const LOGO_HEIGHT = 36;

/** Usable width between the margins: 696pt landscape, 516pt portrait. */
export const STONE_TABLE_WIDTH = 792 - MARGIN_X * 2;
export const PIECE_TABLE_WIDTH = 612 - MARGIN_X * 2;

/**
 * Column budgets must sum to exactly the usable width — anything wider silently
 * draws off the right edge of the sheet instead of wrapping. `smoke:pdf` asserts
 * both the totals and that no glyph lands outside the page.
 */
// The "#" column must hold a three-digit row number without an ellipsis — 300+
// line memos are real (see smoke:pdfscale).
const STONE_COLUMNS: TableColumn[] = [
  { header: "#", width: 24, align: "right" },
  { header: "Lot / SKU", width: 68 },
  { header: "Stone Type", width: 64 },
  { header: "Shape", width: 42 },
  { header: "Qty", width: 26, align: "right" },
  { header: "Carat", width: 42, align: "right" },
  { header: "Color", width: 36 },
  { header: "Clarity", width: 36 },
  { header: "Cut", width: 34 },
  { header: "Measurements", width: 66 },
  { header: "Lab", width: 30 },
  { header: "Cert #", width: 54 },
  // "For" holds the client reference — a ring name, not a code — so it needs
  // the widest budget the sheet can spare or every row ends in an ellipsis.
  { header: "For", width: 66 },
  { header: "Price / ct", width: 50, align: "right" },
  { header: "Amount", width: 58, align: "right" }
];

/** Sized for the portrait sheet, so a mixed document on a landscape page still fits. */
function pieceColumns(brandCol: boolean, valueLabel: string): TableColumn[] {
  if (brandCol) {
    return [
      { header: "#", width: 24, align: "right" },
      { header: "SKU", width: 66 },
      { header: "Brand", width: 66 },
      { header: "Item Type", width: 66 },
      { header: "Metal", width: 58 },
      { header: "Length", width: 40 },
      { header: "Size", width: 34 },
      { header: "Qty", width: 28, align: "right" },
      { header: "For", width: 46 },
      { header: valueLabel, width: 88, align: "right" }
    ];
  }
  return [
    { header: "#", width: 24, align: "right" },
    { header: "SKU", width: 72 },
    { header: "Item Type", width: 90 },
    { header: "Metal", width: 70 },
    { header: "Length", width: 52 },
    { header: "Size", width: 46 },
    { header: "Qty", width: 30, align: "right" },
    { header: "For", width: 52 },
    { header: valueLabel, width: 80, align: "right" }
  ];
}

export const TABLE_LAYOUTS = {
  stone: { columns: STONE_COLUMNS, usableWidth: STONE_TABLE_WIDTH },
  piece: { columns: pieceColumns(false, "Amount"), usableWidth: PIECE_TABLE_WIDTH },
  brandPiece: { columns: pieceColumns(true, "Declared value"), usableWidth: PIECE_TABLE_WIDTH }
};

export type DocumentPdf = {
  filename: string;
  buffer: Buffer;
  documentLabel: string;
};

function safeFilename(base: string): string {
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${cleaned || "document"}.pdf`;
}

/** Exported so the smoke suite can render templates that dev data does not happen to contain. */
export function renderDocument(doc: DocForPdf): Buffer {
  const rows = doc.lineItems.map(buildRow);
  const stones = rows.filter((r): r is StoneRow => r.kind === "stone");
  const pieces = rows.filter((r): r is PieceRow => r.kind === "piece");
  const isBrandOut = doc.type === "BRAND_INVENTORY_OUT";
  const isMemoOut = doc.type === "MEMO_OUT";
  const landscape = stones.length > 0;

  const pdf = new PdfDocument();
  pdf.addPage(landscape);
  const marginX = MARGIN_X;
  const rightEdge = pdf.pageWidth - marginX;
  const bottomMargin = pdf.pageHeight - 72;

  const logo = brandLogo();

  const drawHeaderBlock = (): number => {
    let y = 62;
    if (logo) {
      // Sits on the wordmark's old baseline, so the address, rule and the rest
      // of the block keep their spacing whether or not the asset loaded.
      const width = (LOGO_HEIGHT * logo.width) / logo.height;
      pdf.image(logo, marginX, y - LOGO_HEIGHT + 4, width, LOGO_HEIGHT);
    } else {
      pdf.text(COMPANY_NAME, marginX, y, { size: 22, bold: true });
    }
    pdf.text(COMPANY_ADDRESS, marginX, y + 16, { size: 8, gray: 0.42 });
    pdf.text(COMPANY_CONTACT, marginX, y + 26, { size: 8, gray: 0.42 });

    pdf.text(DOC_LABEL[doc.type], rightEdge, y - 6, { size: 13, bold: true, align: "right" });
    pdf.text(doc.documentNumber || doc.externalReference || DASH, rightEdge, y + 8, {
      size: 11,
      align: "right",
      gray: 0.25
    });
    pdf.text(`Issued ${longDate(doc.issueDate)}`, rightEdge, y + 21, {
      size: 8,
      align: "right",
      gray: 0.42
    });

    y += 38;
    pdf.line(marginX, y, rightEdge, y, { width: 1.4, gray: 0 });
    return y + 18;
  };

  let y = drawHeaderBlock();

  const partyName = doc.vendor?.name ?? doc.client?.name ?? DASH;
  const partyAddress = (doc.client?.shippingAddress ?? doc.vendor?.address ?? "").trim();
  if (isBrandOut) {
    pdf.text("Brand:", marginX, y, { size: 8.5, gray: 0.42 });
    pdf.text(partyName, marginX + 34, y, { size: 8.5, bold: true });
    y += 14;
    pdf.text("Client reference — sent to:", marginX, y, { size: 8.5, gray: 0.42 });
    pdf.text(orDash(doc.externalReference), marginX + 122, y, { size: 8.5 });
    y += 20;
  } else {
    const partyLabel = isMemoOut
      ? "Memo To:"
      : docDirectionOf(doc.type) === "in"
        ? "From:"
        : "To:";
    const nameX = marginX + measureText(partyLabel, 8.5) + 8;
    pdf.text(partyLabel, marginX, y, { size: 8.5, gray: 0.42 });
    pdf.text(partyName, nameX, y, { size: 8.5, bold: true });
    y += 12;
    for (const addressLine of partyAddress.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      pdf.text(addressLine, nameX, y, {
        size: 8,
        gray: 0.25,
        maxWidth: rightEdge - nameX
      });
      y += 10;
    }
    if (isMemoOut) {
      const infoParts: string[] = [];
      const termDays = memoTermDays(doc);
      if (termDays !== null) infoParts.push(`Terms: Net ${termDays}`);
      if (doc.dueDate) infoParts.push(`Return by: ${longDate(doc.dueDate)}`);
      // Jennifer's #0019 note: the client reference also lives at the document
      // level (the per-line "For" column still carries the individual ones).
      if (orDash(doc.externalReference) !== DASH) {
        infoParts.push(`Client ref: ${doc.externalReference?.trim()}`);
      }
      if (infoParts.length > 0) {
        y += 4;
        pdf.text(infoParts.join("   ·   "), marginX, y, {
          size: 8.5,
          gray: 0.25,
          maxWidth: rightEdge - marginX
        });
        y += 12;
      }
    }
    y += 8;
  }

  if (rows.length === 0) {
    // Bills, POs and other line-less documents keep the summary card.
    pdf.text("Due:", marginX, y, { size: 8.5, gray: 0.42 });
    pdf.text(longDate(doc.dueDate), marginX + 26, y, { size: 8.5 });
    y += 14;
    pdf.text("Line items:", marginX, y, { size: 8.5, gray: 0.42 });
    pdf.text("0", marginX + 54, y, { size: 8.5 });
    y += 18;
    pdf.line(marginX, y, rightEdge, y, { width: 0.5, gray: 0.75 });
    y += 14;
    const discount = num(doc.discountAmount) ?? 0;
    pdf.text(`Total: ${money(-discount)}`, rightEdge, y, {
      size: 10,
      bold: true,
      align: "right"
    });
    return pdf.toBuffer();
  }

  const sectionCount = (stones.length ? 1 : 0) + (pieces.length ? 1 : 0);

  if (stones.length > 0) {
    if (sectionCount > 1) {
      pdf.text("STONES", marginX, y, { size: 8, bold: true, gray: 0.42 });
      y += 12;
    }
    y = drawTable(
      pdf,
      STONE_COLUMNS,
      stones.map((r, i) => [
        String(i + 1),
        r.sku,
        r.stoneType,
        r.shape,
        r.qtyFmt,
        r.caratFmt,
        r.color,
        r.clarity,
        r.cut,
        r.measurements,
        r.lab,
        r.cert,
        r.clientRef,
        r.pricePerCtFmt,
        r.amountFmt
      ]),
      { x: marginX, y, bottomMargin, landscape, onNewPage: drawHeaderBlock }
    );
  }

  if (pieces.length > 0) {
    if (stones.length > 0) y += 14;
    if (sectionCount > 1) {
      pdf.text("JEWELRY", marginX, y, { size: 8, bold: true, gray: 0.42 });
      y += 12;
    }
    y = drawTable(
      pdf,
      pieceColumns(isBrandOut, isBrandOut ? "Declared value" : "Amount"),
      pieces.map((r, i) => {
        const cells = [String(i + 1), r.sku];
        if (isBrandOut) cells.push(r.brand);
        cells.push(r.itemType, r.metal, r.lengthFmt, r.sizeFmt, r.qtyFmt, r.clientRef, r.amountFmt);
        return cells;
      }),
      { x: marginX, y, bottomMargin, landscape, onNewPage: drawHeaderBlock }
    );
  }

  const subtotal = rows.reduce((sum, r) => sum + r.amount, 0);
  const totalWeight = stones.reduce((sum, r) => sum + r.weightCt, 0);
  const totalQty = rows.reduce((sum, r) => sum + r.qty, 0);
  const discount = num(doc.discountAmount) ?? 0;

  y += 4;
  pdf.line(marginX, y, rightEdge, y, { width: 1.4, gray: 0 });
  y += 15;
  if (isBrandOut) {
    pdf.text(`Declared value: ${money(subtotal)}`, rightEdge, y, {
      size: 10,
      bold: true,
      align: "right"
    });
    if (totalWeight > 0) {
      pdf.text(`Total weight: ${carats(totalWeight)} ct`, rightEdge - 150, y, {
        size: 9,
        gray: 0.42,
        align: "right"
      });
    }
  } else {
    const countParts: string[] = [];
    if (totalQty > 0) countParts.push(`Total qty: ${totalQty}`);
    if (totalWeight > 0) countParts.push(`Total weight: ${carats(totalWeight)} ct`);
    if (countParts.length > 0) {
      pdf.text(countParts.join("   ·   "), marginX, y, { size: 9, gray: 0.42 });
    }
    pdf.text(`Subtotal: ${money(subtotal)}`, rightEdge, y, {
      size: 9,
      gray: 0.25,
      align: "right"
    });
    y += 13;
    if (discount > 0) {
      pdf.text(`Discount: ${money(-discount)}`, rightEdge, y, {
        size: 9,
        gray: 0.25,
        align: "right"
      });
      y += 13;
    }
    pdf.text(`Grand Total: ${money(Math.max(0, subtotal - discount))}`, rightEdge, y, {
      size: 10.5,
      bold: true,
      align: "right"
    });
  }

  if (isMemoOut) {
    const declWidth = rightEdge - marginX;
    const declSize = 7.5;
    const declLineHeight = 9.5;
    const paragraphs = MEMO_DECLARATION.map((p) => wrapText(p, declSize, declWidth));
    const blockHeight =
      14 + paragraphs.reduce((sum, lines) => sum + lines.length * declLineHeight + 6, 0);
    if (y + blockHeight > pdf.pageHeight - 60) {
      pdf.addPage(landscape);
      y = drawHeaderBlock();
    } else {
      y += 20;
    }
    pdf.text("Declaration:", marginX, y, { size: 8, bold: true });
    pdf.line(marginX, y + 2, marginX + measureText("Declaration:", 8, true), y + 2, {
      width: 0.5,
      gray: 0.25
    });
    y += 12;
    for (const lines of paragraphs) {
      for (const line of lines) {
        pdf.text(line, marginX, y, { size: declSize, gray: 0.25 });
        y += declLineHeight;
      }
      y += 6;
    }
    y += 4;
  } else {
    y += 18;
  }
  pdf.line(marginX, y, rightEdge, y, { width: 0.5, gray: 0.8 });
  y += 12;
  pdf.text("Generated by RADIIA", marginX, y, { size: 7.5, gray: 0.6 });
  const unit = isBrandOut ? "piece" : "line";
  pdf.text(`${rows.length} ${unit}${rows.length === 1 ? "" : "s"}`, rightEdge, y, {
    size: 7.5,
    gray: 0.6,
    align: "right"
  });

  return pdf.toBuffer();
}

export async function buildDocumentPdf(documentId: string): Promise<DocumentPdf | null> {
  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    include: DOC_PDF_INCLUDE
  });
  if (!doc) return null;

  const label = doc.documentNumber || doc.externalReference || DOC_LABEL[doc.type];
  return {
    filename: safeFilename(label),
    buffer: renderDocument(doc),
    documentLabel: label
  };
}

export async function buildDocumentPdfs(documentIds: string[]): Promise<DocumentPdf[]> {
  const pdfs: DocumentPdf[] = [];
  for (const id of documentIds) {
    const pdf = await buildDocumentPdf(id);
    if (pdf) pdfs.push(pdf);
  }
  return pdfs;
}
