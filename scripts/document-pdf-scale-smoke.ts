/**
 * Does a document PDF survive 300+ lines?
 *
 * drawTable breaks pages on its own, but everything drawn AFTER it — the rule,
 * the total, the footer — is placed at whatever y the table left behind, with no
 * page-break check of its own. So the interesting line counts are not "lots",
 * they are the ones that land the last row just above the bottom margin.
 *
 * The writer emits every coordinate as (pageHeight - y) into an uncompressed
 * content stream, so anything drawn off the paper shows up as a NEGATIVE pdf
 * coordinate. That is the assertion: no ink outside the page box, on any page,
 * at any line count.
 */
import { writeFileSync } from "node:fs";
import { prisma } from "@/db";
import { createOutboundDocument } from "@/modules/ims/documents.service";
import { createInventoryItem } from "@/modules/ims/inventory.service";
import { buildDocumentPdf, PIECE_TABLE_WIDTH, STONE_TABLE_WIDTH, TABLE_LAYOUTS } from "@/modules/ims/document-pdf";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

const PREFIX = "SMOKE-PDFSCALE";
/** Set PDF_SMOKE_OUT to keep a copy to look at; unset, the run leaves no files. */
const OUT_DIR = process.env.PDF_SMOKE_OUT ?? null;

type PageInk = { index: number; height: number; width: number; minY: number; maxY: number; ops: number };

/**
 * Walks the raw PDF: page boxes in order, then every drawing op's y coordinate.
 * Text is `... x y Td`, rules are `... m ... l S`, images are a `cm` matrix.
 */
function readInk(buf: Buffer): PageInk[] {
  const raw = buf.toString("latin1");
  const boxes = [...raw.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => ({
    width: Number(m[1]),
    height: Number(m[2])
  }));
  const streams = [...raw.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((m) => m[1]);
  // Image streams are binary deflate; page content is plain text ops.
  const contents = streams.filter((s) => /\bTd\b|\bre\b|\bl S\b/.test(s) && !/�/.test(s));

  return contents.map((body, index) => {
    const ys: number[] = [];
    for (const m of body.matchAll(/(-?[\d.]+) (-?[\d.]+) Td\b/g)) ys.push(Number(m[2]));
    for (const m of body.matchAll(/(-?[\d.]+) (-?[\d.]+) m ([\d.-]+) (-?[\d.]+) l/g)) {
      ys.push(Number(m[2]), Number(m[4]));
    }
    for (const m of body.matchAll(/[\d.]+ 0 0 ([\d.]+) [\d.-]+ (-?[\d.]+) cm/g)) {
      ys.push(Number(m[2]), Number(m[2]) + Number(m[1]));
    }
    const box = boxes[index] ?? boxes[0] ?? { width: 612, height: 792 };
    return {
      index,
      height: box.height,
      width: box.width,
      minY: ys.length ? Math.min(...ys) : box.height / 2,
      maxY: ys.length ? Math.max(...ys) : box.height / 2,
      ops: ys.length
    };
  });
}

async function main(): Promise<void> {
  const user = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
  const brand =
    (await prisma.company.findFirst({ where: { name: `${PREFIX} Brand` } })) ??
    (await prisma.company.create({ data: { name: `${PREFIX} Brand`, clientStatus: "ACTIVE" } }));
  const store =
    (await prisma.company.findFirst({ where: { name: `${PREFIX} Store` } })) ??
    (await prisma.company.create({
      data: { name: `${PREFIX} Store`, clientStatus: "ACTIVE", defaultMemoTermsDays: 30 }
    }));

  console.log("\n[1] the table layouts still fit their page");
  const stoneWidth = TABLE_LAYOUTS.stone.columns.reduce((s: number, c: any) => s + c.width, 0);
  const pieceWidth = TABLE_LAYOUTS.piece.columns.reduce((s: number, c: any) => s + c.width, 0);
  const brandWidth = TABLE_LAYOUTS.brandPiece.columns.reduce((s: number, c: any) => s + c.width, 0);
  check(`stone columns ${stoneWidth} <= ${STONE_TABLE_WIDTH} landscape`, stoneWidth <= STONE_TABLE_WIDTH, stoneWidth);
  check(`jewelry columns ${pieceWidth} <= ${PIECE_TABLE_WIDTH} portrait`, pieceWidth <= PIECE_TABLE_WIDTH, pieceWidth);
  check(`brand-out columns ${brandWidth} <= ${PIECE_TABLE_WIDTH} portrait`, brandWidth <= PIECE_TABLE_WIDTH, brandWidth);

  const created: string[] = [];
  const pool: string[] = [];
  async function ensurePieces(n: number): Promise<string[]> {
    while (pool.length < n) {
      const i = pool.length;
      const res = await createInventoryItem({
        itemType: "JEWELRY",
        itemName: `Signature Baby Oval Hoops ${i}`,
        vendorSku: `RP55X${i}`,
        brandOwnerId: brand.id,
        jewelry: {
          jewelryItemType: "Earrings",
          metal: "20k Peach Gold",
          ringSize: '7.5"',
          lengthMm: 18,
          quantity: 1,
          productionCost: 695,
          wholesalePrice: 1495,
          retailPrice: 2550
        }
      } as never);
      if (!res.ok) throw new Error(`seed ${i}: ${res.error}`);
      created.push(res.item.id);
      pool.push(res.item.id);
    }
    return pool.slice(0, n);
  }

  // The counts that matter are the ones near a page boundary, not just "lots".
  const COUNTS = [1, 2, 30, 38, 39, 40, 41, 42, 43, 44, 45, 78, 79, 80, 81, 82, 120, 320];
  await ensurePieces(Math.max(...COUNTS));

  console.log(`\n[2] ${COUNTS.length} line counts, every page checked for ink off the paper`);
  const docIds: string[] = [];
  let biggest: { count: number; pages: number; bytes: number; edge: number } | null = null;

  for (const n of COUNTS) {
    const ids = await ensurePieces(n);
    const doc = await createOutboundDocument(
      { type: "MEMO_OUT", clientId: store.id, inventoryItemIds: ids } as never,
      user.id
    );
    if (!doc.ok) {
      check(`${n} lines: memo created`, false, doc.error);
      continue;
    }
    docIds.push(doc.document.id);

    const built = await buildDocumentPdf(doc.document.id);
    if (!built) {
      check(`${n} lines: pdf built`, false, "buildDocumentPdf returned null");
      continue;
    }
    const pages = readInk(built.buffer);
    const offPage = pages.filter((p) => p.minY < 0 || p.maxY > p.height);
    const blank = pages.filter((p) => p.ops === 0);

    const ok = pages.length > 0 && offPage.length === 0 && blank.length === 0;
    check(
      `${String(n).padStart(3)} lines -> ${pages.length} page(s), ${(built.buffer.length / 1024).toFixed(0)} KB`,
      ok,
      offPage.length
        ? offPage.map((p) => ({ page: p.index + 1, minY: p.minY, maxY: p.maxY, height: p.height }))
        : blank.length
          ? { blankPages: blank.map((p) => p.index + 1) }
          : undefined
    );

    // Reverse the stock so the next, longer document can use the same pieces.
    await prisma.documentLineItem.deleteMany({ where: { documentId: doc.document.id } });
    await prisma.document.delete({ where: { id: doc.document.id } });
    await prisma.itemStatusHistory.deleteMany({ where: { inventoryItemId: { in: ids } } });
    await prisma.inventoryItem.updateMany({ where: { id: { in: ids } }, data: { status: "IN_STOCK" } });
    await prisma.jewelryDetail.updateMany({ where: { inventoryItemId: { in: ids } }, data: { remainingQty: 1 } });

    if (n === Math.max(...COUNTS)) {
      biggest = {
        count: n,
        pages: pages.length,
        bytes: built.buffer.length,
        edge: Math.min(...pages.map((pg) => Math.min(pg.minY, pg.height - pg.maxY)))
      };
      if (OUT_DIR) {
        const path = `${OUT_DIR}/memo-${n}-lines.pdf`;
        writeFileSync(path, built.buffer);
        console.log(`       wrote ${path} for eyeballing`);
      }
    }
  }

  if (biggest) {
    console.log("\n[3] the 320-line memo in detail");
    // On the page holding the totals, the footer is the last thing drawn and the
    // only thing with no page-break check behind it. Staying inside the paper is
    // not enough — most printers cannot put ink in the outer ~18pt.
    console.log(`       closest ink to the paper edge: ${biggest.edge.toFixed(1)}pt`);
    check("nothing crowds the unprintable margin", biggest.edge >= 18, biggest.edge);
    check("it paginates rather than piling up", biggest.pages > 1, biggest.pages);
    check("roughly 40-46 lines a page", biggest.pages >= 7 && biggest.pages <= 9, biggest.pages);
    check("the file stays a sane size", biggest.bytes < 2_000_000, biggest.bytes);
  }

  await prisma.documentLineItem.deleteMany({ where: { documentId: { in: docIds } } });
  await prisma.itemStatusHistory.deleteMany({ where: { inventoryItemId: { in: created } } });
  await prisma.document.deleteMany({ where: { id: { in: docIds } } });
  await prisma.inventoryItem.deleteMany({ where: { id: { in: created } } });
  await prisma.company.deleteMany({ where: { id: { in: [store.id, brand.id] } } }).catch(() => undefined);
  console.log(`\ncleaned up ${created.length} item(s)`);

  console.log(`\n${"=".repeat(52)}`);
  console.log(`${pass}/${pass + fail} passed`);
  if (fail > 0) {
    console.log(`FAILURES:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error("SMOKE CRASHED:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
