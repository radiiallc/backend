import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { prisma } from "../src/db";
import {
  buildDocumentPdf,
  type DocForPdf,
  renderDocument,
  TABLE_LAYOUTS
} from "../src/modules/ims/document-pdf";
import { brandLogo } from "../src/integrations/pdf/brand-logo";
import {
  CELL_PADDING,
  drawTable,
  imageFromRgb,
  measureText,
  PdfDocument
} from "../src/integrations/pdf/pdf-writer";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * Walks the xref table and confirms every offset lands on its own "N 0 obj"
 * header. A writer that miscounts byte offsets still "looks fine" as a string
 * but is rejected by strict readers, so this is the assertion that matters.
 */
function verifyPdfStructure(label: string, buffer: Buffer): void {
  const raw = buffer.toString("latin1");

  check(`${label}: starts with %PDF header`, raw.startsWith("%PDF-1.4\n"));
  check(`${label}: ends with %%EOF`, raw.trimEnd().endsWith("%%EOF"));

  const startxrefMatch = raw.match(/startxref\n(\d+)\n%%EOF/);
  check(`${label}: has startxref`, startxrefMatch !== null);
  if (!startxrefMatch) return;

  const xrefOffset = Number(startxrefMatch[1]);
  check(
    `${label}: startxref points at the xref keyword`,
    raw.slice(xrefOffset, xrefOffset + 4) === "xref",
    `found ${JSON.stringify(raw.slice(xrefOffset, xrefOffset + 12))}`
  );

  const sizeMatch = raw.match(/\/Size (\d+)/);
  check(`${label}: trailer declares /Size`, sizeMatch !== null);
  if (!sizeMatch) return;

  const size = Number(sizeMatch[1]);
  const xrefBody = raw.slice(xrefOffset);
  const entryRe = /^(\d{10}) (\d{5}) ([nf]) $/gm;
  const offsets: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xrefBody)) !== null) {
    offsets.push(Number(m[1]));
  }
  check(
    `${label}: xref has ${size} entries`,
    offsets.length === size,
    `found ${offsets.length}`
  );

  let allResolve = true;
  for (let i = 1; i < offsets.length; i += 1) {
    const expected = `${i} 0 obj`;
    const actual = raw.slice(offsets[i], offsets[i] + expected.length);
    if (actual !== expected) {
      allResolve = false;
      check(`${label}: xref entry ${i} resolves`, false, `expected "${expected}", got "${actual}"`);
      break;
    }
  }
  if (allResolve) check(`${label}: every xref offset resolves to its object`, true);

  // Binary image streams can contain the bytes "\nendstream" by chance, so the
  // declared length has to be trusted and the terminator checked where it says.
  const declaredLengths = [...raw.matchAll(/\/Length (\d+) >>\nstream\n/g)];
  let lengthsOk = declaredLengths.length > 0;
  for (const match of declaredLengths) {
    const streamStart = (match.index ?? 0) + match[0].length;
    const end = streamStart + Number(match[1]);
    if (raw.slice(end, end + 10) !== "\nendstream") {
      lengthsOk = false;
      break;
    }
  }
  check(`${label}: every /Length matches its stream`, lengthsOk);

  const pageCount = (raw.match(/\/Type \/Page[^s]/g) || []).length;
  const declaredCount = Number((raw.match(/\/Count (\d+)/) || [])[1] ?? -1);
  check(
    `${label}: /Count matches page objects`,
    pageCount === declaredCount,
    `objects=${pageCount} count=${declaredCount}`
  );
}

/**
 * Re-measures every text run in the stream and confirms it sits inside the
 * page. Off-page content is the failure mode a structural check cannot see:
 * the PDF stays perfectly valid, the ink just lands past the paper edge.
 */
function verifyNothingOffPage(label: string, buffer: Buffer): void {
  const raw = buffer.toString("latin1");
  const mediaBoxes = [...raw.matchAll(/\/MediaBox \[0 0 (\d+) (\d+)\]/g)].map((m) => ({
    width: Number(m[1]),
    height: Number(m[2])
  }));
  if (mediaBoxes.length === 0) {
    check(`${label}: has a MediaBox`, false);
    return;
  }
  // Every page in a document shares an orientation, so one box governs all runs.
  const { width, height } = mediaBoxes[0];

  const runRe = /BT \/(F[12]) ([\d.]+) Tf ([-\d.]+) ([-\d.]+) Td \((.*?)\) Tj ET/g;
  let worstRight = 0;
  let worstLabel = "";
  let offPage = 0;
  let runs = 0;
  let m: RegExpExecArray | null;

  while ((m = runRe.exec(raw)) !== null) {
    runs += 1;
    const bold = m[1] === "F2";
    const size = Number(m[2]);
    const x = Number(m[3]);
    const y = Number(m[4]);
    const text = m[5].replace(/\\([\\()])/g, "$1");
    const right = x + measureText(text, size, bold);
    if (right > worstRight) {
      worstRight = right;
      worstLabel = text;
    }
    if (right > width || x < 0 || y < 0 || y > height) offPage += 1;
  }

  check(`${label}: found text runs to measure`, runs > 0);
  check(
    `${label}: no text drawn outside the page`,
    offPage === 0,
    `${offPage} run(s) off-page; widest ends at ${worstRight.toFixed(1)}pt of ${width}pt ("${worstLabel}")`
  );

  const imageRe = /q ([\d.]+) 0 0 ([\d.]+) ([-\d.]+) ([-\d.]+) cm \/Im\d+ Do Q/g;
  let offPageImages = 0;
  while ((m = imageRe.exec(raw)) !== null) {
    const w = Number(m[1]);
    const h = Number(m[2]);
    const x = Number(m[3]);
    const y = Number(m[4]);
    if (x < 0 || y < 0 || x + w > width || y + h > height) offPageImages += 1;
  }
  check(`${label}: no image drawn outside the page`, offPageImages === 0);
}

/**
 * Confirms neighbouring cells keep a gutter. A right-aligned column that ends
 * exactly where the next one starts is still a valid PDF — it just reads as
 * "0.73Red" — so only re-measuring the runs catches it. Single-page documents
 * only: runs are grouped by baseline, which pages would smear together.
 */
function verifyNoCellCollisions(label: string, buffer: Buffer): void {
  const raw = buffer.toString("latin1");
  if ((raw.match(/\/Type \/Page[^s]/g) || []).length !== 1) return;

  const runRe = /BT \/(F[12]) ([\d.]+) Tf ([-\d.]+) ([-\d.]+) Td \((.*?)\) Tj ET/g;
  const byLine = new Map<string, { x: number; right: number; text: string }[]>();
  let m: RegExpExecArray | null;
  while ((m = runRe.exec(raw)) !== null) {
    const bold = m[1] === "F2";
    const size = Number(m[2]);
    const x = Number(m[3]);
    const text = m[5].replace(/\\([\\()])/g, "$1");
    const line = byLine.get(m[4]) ?? [];
    line.push({ x, right: x + measureText(text, size, bold), text });
    byLine.set(m[4], line);
  }

  let collisions = 0;
  let worst = "";
  for (const runs of byLine.values()) {
    runs.sort((a, b) => a.x - b.x);
    for (let i = 1; i < runs.length; i += 1) {
      if (runs[i].x < runs[i - 1].right + 1) {
        collisions += 1;
        if (!worst) worst = `"${runs[i - 1].text}" / "${runs[i].text}"`;
      }
    }
  }
  check(`${label}: adjacent cells keep a gutter`, collisions === 0, `${collisions} touching (${worst})`);
}

function writerUnitTests(): void {
  console.log("\n1. PDF writer");

  const doc = new PdfDocument();
  doc.addPage();
  doc.text("Hello", 50, 50);
  verifyPdfStructure("single page", doc.toBuffer());

  const esc = new PdfDocument();
  esc.addPage();
  esc.text("Parens ( ) and a backslash \\ and (nested)", 50, 50);
  const escRaw = esc.toBuffer().toString("latin1");
  check(
    "escapes ( ) and backslash in strings",
    escRaw.includes("Parens \\( \\) and a backslash \\\\ and \\(nested\\)")
  );

  const uni = new PdfDocument();
  uni.addPage();
  uni.text("7.03 × 4.35 — done · ok", 50, 50);
  const uniRaw = uni.toBuffer().toString("latin1");
  check(
    "maps × — · to WinAnsi bytes",
    uniRaw.includes(`7.03 ${String.fromCharCode(0xd7)} 4.35 ${String.fromCharCode(0x97)} done ${String.fromCharCode(0xb7)} ok`)
  );

  const cjk = new PdfDocument();
  cjk.addPage();
  cjk.text("ok 日本 end", 50, 50);
  check("unmappable glyphs degrade to ?", cjk.toBuffer().toString("latin1").includes("ok ?? end"));

  check("measureText scales with size", measureText("Hello", 20) === measureText("Hello", 10) * 2);
  check("bold is wider than regular", measureText("Hello", 10, true) > measureText("Hello", 10));
  check("empty string measures zero", measureText("", 10) === 0);

  const trunc = new PdfDocument();
  trunc.addPage();
  trunc.text("An extremely long cell value that cannot possibly fit", 50, 50, { maxWidth: 60 });
  const truncRaw = trunc.toBuffer().toString("latin1");
  check("truncates to maxWidth with an ellipsis", truncRaw.includes(String.fromCharCode(0x85)));
  check(
    "truncated text is shorter than the source",
    !truncRaw.includes("cannot possibly fit")
  );

  const land = new PdfDocument();
  land.addPage(true);
  check("landscape page is 792 wide", land.pageWidth === 792 && land.pageHeight === 612);

  const img = new PdfDocument();
  img.addPage();
  // 2x1 pixels: one opaque red, one half-transparent blue.
  const sample = imageFromRgb(
    2,
    1,
    Buffer.from([255, 0, 0, 0, 0, 255]),
    Buffer.from([255, 128])
  );
  img.image(sample, 40, 40, 60, 30);
  img.image(sample, 40, 90, 60, 30); // same image twice — written once
  const imgRaw = img.toBuffer().toString("latin1");
  check("draws an image XObject", /\/Im0 Do Q/.test(imgRaw));
  // One RGB object plus its alpha mask — the second placement adds no objects.
  check("reuses one XObject for a repeated image", (imgRaw.match(/\/Subtype \/Image/g) || []).length === 2);
  check("transparency becomes an /SMask", imgRaw.includes("/SMask"));
  check(
    "image is placed with a top-left origin",
    imgRaw.includes("q 60.00 0 0 30.00 40.00 722.00 cm /Im0 Do Q"),
    "expected the first placement 40pt from the top of a 792pt page"
  );
  check("page resources declare the XObject", /\/XObject << \/Im0 \d+ 0 R >>/.test(imgRaw));
  verifyPdfStructure("image page", img.toBuffer());

  const paged = new PdfDocument();
  paged.addPage();
  const rows = Array.from({ length: 120 }, (_, i) => [`SKU-${i}`, `Row ${i}`, "1.00"]);
  drawTable(
    paged,
    [
      { header: "SKU", width: 100 },
      { header: "Name", width: 200 },
      { header: "Amt", width: 60, align: "right" }
    ],
    rows,
    { x: 48, y: 120, bottomMargin: 720, landscape: false, onNewPage: () => 56 }
  );
  check("long tables paginate", paged.pageCount > 1, `pages=${paged.pageCount}`);
  verifyPdfStructure("paginated table", paged.toBuffer());
}

function columnBudgetTests(): void {
  console.log("\n2. Table column budgets");
  for (const [name, layout] of Object.entries(TABLE_LAYOUTS)) {
    const total = layout.columns.reduce((sum, c) => sum + c.width, 0);
    check(
      `${name} columns fit the sheet (${total} of ${layout.usableWidth}pt)`,
      total <= layout.usableWidth
    );
    const tight = layout.columns.filter(
      (c) => measureText(c.header, 8, false) > c.width - CELL_PADDING * 2
    );
    check(
      `${name} headers fit their columns, padding included`,
      tight.length === 0,
      tight.map((c) => `${c.header} needs ${measureText(c.header, 8).toFixed(0)}pt`).join(", ")
    );
  }
}

function logoTests(): void {
  console.log("\n2b. Letterhead logo");
  const logo = brandLogo();
  check("decodes the RADIIA logo asset", logo !== null);
  if (!logo) return;
  check(`logo has pixel dimensions (${logo.width}×${logo.height})`, logo.width > 0 && logo.height > 0);
  check("logo colour data is compressed", logo.rgb.length > 0 && logo.rgb.length < logo.width * logo.height * 3);
  check("logo keeps its transparency mask", logo.alpha !== null);
  check("logo is cached, not re-decoded", brandLogo() === logo);
}

async function documentTests(): Promise<void> {
  console.log("\n3. Real documents from the dev database");

  const docs = await prisma.document.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      type: true,
      documentNumber: true,
      externalReference: true,
      _count: { select: { lineItems: true } }
    },
    take: 400
  });

  if (docs.length === 0) {
    console.log("  skip — no documents in the dev database");
    return;
  }

  // One document per type, preferring the one with the most line items so the
  // itemised tables are actually exercised rather than the empty summary card.
  const richest = new Map<string, (typeof docs)[number]>();
  for (const doc of docs) {
    const held = richest.get(doc.type);
    if (!held || doc._count.lineItems > held._count.lineItems) richest.set(doc.type, doc);
  }
  const sample = [...richest.values()];

  console.log(`  ${docs.length} document(s) present; sampling ${sample.length} type(s)`);

  const outDir = process.env.PDF_SMOKE_OUT ?? ".";
  for (const doc of sample) {
    const pdf = await buildDocumentPdf(doc.id);
    if (!pdf) {
      check(`${doc.type}: builds a PDF`, false, "returned null");
      continue;
    }
    check(`${doc.type}: builds a PDF (${doc._count.lineItems} line(s))`, true);
    verifyPdfStructure(doc.type, pdf.buffer);
    verifyNothingOffPage(doc.type, pdf.buffer);
    verifyNoCellCollisions(doc.type, pdf.buffer);

    const raw = pdf.buffer.toString("latin1");
    // With the asset present the mark must be drawn; the wordmark is only the
    // fallback for an environment where the file could not be read.
    check(
      `${doc.type}: renders the RADIIA letterhead`,
      brandLogo() ? raw.includes("/Im0 Do") : raw.includes("(RADIIA)")
    );
    if (doc._count.lineItems > 0) {
      check(
        `${doc.type}: renders an itemised table, not the summary card`,
        raw.includes("(Amount)") || raw.includes("(Declared value)"),
        "no table header found"
      );
      check(
        `${doc.type}: renders a total with a currency symbol`,
        /\((Grand Total|Total|Declared value): -?\$[\d,.]+\)/.test(raw)
      );
    }
    const label = doc.documentNumber || doc.externalReference;
    if (label) {
      check(
        `${doc.type}: renders its own reference (${label})`,
        raw.includes(`(${label})`)
      );
    }
    check(
      `${doc.type}: filename ends in .pdf`,
      pdf.filename.endsWith(".pdf") && !/[/\\:*?"<>|]/.test(pdf.filename),
      pdf.filename
    );

    if (outDir !== ".") {
      writeFileSync(join(outDir, `${doc.type}-${pdf.filename}`), pdf.buffer);
    }
  }

  const missing = await buildDocumentPdf("does-not-exist");
  check("unknown document id returns null", missing === null);
}

/**
 * Dev data currently holds no Memo Out with stone lines, so the stones template
 * (the #0019 reference layout, and the only landscape path) would otherwise go
 * untested. The item comes from the database; only the document wrapping it is
 * synthetic, so nothing is written.
 */
async function stonesTemplateTest(): Promise<void> {
  console.log("\n4. Memo Out stones template");

  const items = await prisma.inventoryItem.findMany({
    where: { stone: { isNot: null } },
    include: { stone: true, jewelry: true, material: true, brandOwner: { select: { name: true } } },
    take: 3
  });

  if (items.length === 0) {
    console.log("  skip — no stone items in the dev database");
    return;
  }

  const issueDate = new Date("2026-08-25T00:00:00Z");
  const dueDate = new Date("2026-09-08T00:00:00Z");
  const doc = {
    id: "synthetic-memo",
    type: "MEMO_OUT",
    documentNumber: "MEM-9001",
    externalReference: "Arden job 12",
    status: "OPEN",
    vendorId: null,
    vendor: null,
    clientId: "c1",
    client: { name: "Reinstein Ross", shippingAddress: "227 Mulberry St\nNew York, NY 10012" },
    issueDate,
    dueDate,
    discountAmount: 100,
    notes: null,
    emailedAt: null,
    quickbooksSyncedAt: null,
    closeReason: null,
    parentDocumentId: null,
    createdById: "u1",
    createdAt: issueDate,
    updatedAt: issueDate,
    lineItems: items.map((item, i) => ({
      id: `l${i}`,
      documentId: "synthetic-memo",
      inventoryItemId: item.id,
      inventoryItem: item,
      lineStatus: "ON_MEMO",
      resolvedByDocumentId: null,
      quantity: null,
      caratWeight: item.stone?.weightCt ?? null,
      unitPrice: null,
      totalPrice: item.stone?.totalWholesalePrice ?? null,
      discountAmount: null,
      clientReference: i === 0 ? "Client ref A" : null,
      notes: null,
      createdAt: issueDate
    }))
  } as unknown as DocForPdf;

  const buffer = renderDocument(doc);
  const raw = buffer.toString("latin1");

  verifyPdfStructure("memo out stones", buffer);
  verifyNothingOffPage("memo out stones", buffer);
  verifyNoCellCollisions("memo out stones", buffer);
  check("stones template goes landscape", raw.includes("/MediaBox [0 0 792 612]"));
  check("letterhead draws the logo, not the wordmark", raw.includes("/Im0 Do") && !raw.includes("(RADIIA)"));
  check("renders the letterhead contact line", raw.includes("212.221.3250 | production@radiia.co"));
  check("renders the Memo To: party", raw.includes("(Memo To:)") && raw.includes("(Reinstein Ross)"));
  check(
    "renders the client shipping address",
    raw.includes("(227 Mulberry St)") && raw.includes("(New York, NY 10012)")
  );
  check("renders Net-day terms from the return date", raw.includes("Terms: Net 14"));
  check("renders the return-by date", raw.includes("Return by: September 8, 2026"));
  check("renders the doc-level client ref", raw.includes("Client ref: Arden job 12"));
  check("renders the stone column headers", raw.includes("(Lot / SKU)") && raw.includes("(Cert #)"));
  check("renders the Qty column header", raw.includes("(Qty)"));
  check("renders Price / ct", raw.includes("(Price / ct)"));
  check("renders the per-line client reference", raw.includes("(Client ref A)"));
  check("renders a total weight in carats", /\(Total weight: [\d,.]+ ct\)/.test(raw));
  // Every synthetic line is a weight-only draw (quantity null), so no piece
  // count may be invented: no qty total, and no defaulted per-line "1".
  check("null quantities are never summed into a qty total", !raw.includes("(Total qty:"));
  check("renders the subtotal", /\(Subtotal: \$[\d,.]+\)/.test(raw));
  check("renders the discount line", /\(Discount: -\$100\.00\)/.test(raw));
  check("renders the grand total", /\(Grand Total: \$[\d,.]+\)/.test(raw));
  check("renders the declaration heading", raw.includes("(Declaration:)"));
  // Single words only — the greedy wrap may break any multi-word phrase across lines.
  check(
    "renders the declaration body",
    raw.includes("memorandum") && raw.includes("guaranteeing")
  );
  check("renders the line count footer", /\(\d+ lines?\)/.test(raw));
  // A SKU longer than its column is truncated with an ellipsis rather than
  // overrunning the neighbouring cell, so accept either form here.
  const skuRendered = (sku: string) =>
    raw.includes(`(${sku})`) || raw.includes(`(${sku.slice(0, 6)}`);
  check("renders every sampled SKU", items.every((it) => skuRendered(it.sku)));

  const outDir = process.env.PDF_SMOKE_OUT;
  if (outDir) writeFileSync(join(outDir, "SYNTHETIC-memo-out-stones.pdf"), buffer);
}

async function main(): Promise<void> {
  writerUnitTests();
  columnBudgetTests();
  logoTests();
  await documentTests();
  await stonesTemplateTest();

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) process.exitCode = 1;
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
