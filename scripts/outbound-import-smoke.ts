/**
 * The bulk-send matcher: a spreadsheet of identifiers -> outbound lines.
 *
 * What matters here is not the happy path but the rejections — a row that
 * silently fails to match is stock that quietly does not ship.
 */
import { prisma } from "@/db";
import { createOutboundDocument } from "@/modules/ims/documents.service";
import { createInventoryItem } from "@/modules/ims/inventory.service";
import { parseOutboundUpload } from "@/modules/ims/outbound-import";

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

const PREFIX = "SMOKE-OUTIMP";

async function main(): Promise<void> {
  const user = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
  const brand =
    (await prisma.company.findFirst({ where: { name: `${PREFIX} Brand` } })) ??
    (await prisma.company.create({ data: { name: `${PREFIX} Brand`, clientStatus: "ACTIVE" } }));
  const store =
    (await prisma.company.findFirst({ where: { name: `${PREFIX} Store` } })) ??
    (await prisma.company.create({ data: { name: `${PREFIX} Store`, clientStatus: "ACTIVE" } }));

  const created: string[] = [];
  // RADIIA mints its own SKU and ignores any we suggest, so the sheet a sender
  // uploads always carries a minted RAD-##### — take it back off the item.
  type Piece = { id: string; sku: string };
  async function piece(style: string | null, quantity: number, name: string): Promise<Piece> {
    const res = await createInventoryItem({
      itemType: "JEWELRY",
      itemName: name,
      vendorSku: style ?? undefined,
      brandOwnerId: brand.id,
      jewelry: {
        jewelryItemType: "Earrings",
        metal: "20k Peach",
        quantity,
        productionCost: 695,
        wholesalePrice: 1000,
        retailPrice: 1550
      }
    } as never);
    if (!res.ok) throw new Error(`could not create ${name}: ${res.error}`);
    created.push(res.item.id);
    return { id: res.item.id, sku: res.item.sku };
  }

  const hoops = await piece("RP55X10", 16, "Signature Baby Oval Hoops");
  const twin = await piece("RP55X10", 1, "Duplicate style, different piece");
  const ring = await piece("DPGRYDI", 1, "Assorted drop ring");
  const band = await piece("D100SEMI", 4, "Semi band");

  const run = (csv: string, docType: "MEMO_OUT" | "INVOICE" = "MEMO_OUT", scoped = true) =>
    parseOutboundUpload({ docType, csv, brandOwnerId: scoped ? brand.id : null });

  console.log("\n[1] matching by RADIIA SKU");
  const r1 = await run(`Item Name,RADIIA SKU,Quantity\nSignature Baby Oval Hoops,${ring.sku},\n`);
  check("one row, one match", r1.okCount === 1 && r1.errorCount === 0, r1.rows);
  check("the line is ready to post", r1.lines.length === 1 && r1.lines[0].inventoryItemId === ring.id, r1.lines);
  check("the whole piece goes, no quantity", r1.lines[0].quantity === undefined, r1.lines[0]);

  console.log("\n[2] matching by the designer's style number");
  const r2 = await run(`Vendor SKU (style #),Quantity\nDPGRYDI,\n`);
  check("style number finds the item", r2.okCount === 1, r2.rows);
  check("and resolves to the right SKU", r2.rows[0].sku === `${ring.sku}`, r2.rows[0]);

  console.log("\n[3] a style number retyped by hand still matches");
  const r3 = await run(`Vendor SKU (style #)\n  dpgrydi  \n`);
  check("case and padding are forgiven", r3.okCount === 1 && r3.rows[0].sku === `${ring.sku}`, r3.rows[0]);

  console.log("\n[4] a style number shared by two pieces is refused, not guessed");
  const r4 = await run(`Vendor SKU (style #)\nRP55X10\n`);
  check("the row is rejected", r4.errorCount === 1, r4.rows);
  check("state is ambiguous", r4.rows[0].state === "ambiguous", r4.rows[0].state);
  check("and it names both candidates", (r4.rows[0].error ?? "").includes(`${hoops.sku}`) && (r4.rows[0].error ?? "").includes(`${twin.sku}`), r4.rows[0].error);
  check("nothing ambiguous reaches the lines", r4.lines.length === 0, r4.lines);

  console.log("\n[5] the RADIIA SKU settles it");
  const r5 = await run(`RADIIA SKU,Vendor SKU (style #)\n${hoops.sku},RP55X10\n`);
  check("SKU wins over the shared style number", r5.okCount === 1 && r5.rows[0].inventoryItemId === hoops.id, r5.rows[0]);

  console.log("\n[6] an unknown identifier");
  const r6 = await run(`RADIIA SKU\nRAD-99999\n`);
  check("rejected as not found", r6.rows[0].state === "notFound", r6.rows[0]);
  check("and echoes what they wrote", r6.rows[0].reference === "RAD-99999", r6.rows[0].reference);

  console.log("\n[7] the same item on two rows");
  const r7 = await run(`RADIIA SKU\n${ring.sku}\n${ring.sku}\n`);
  check("the first row matches", r7.rows[0].ok, r7.rows[0]);
  check("the second is flagged duplicate", r7.rows[1].state === "duplicate", r7.rows[1]);
  check("and points at the earlier row", (r7.rows[1].error ?? "").includes("row 2"), r7.rows[1].error);
  check("it is sent once, not twice", r7.lines.length === 1, r7.lines);

  console.log("\n[8] partial piece counts");
  const r8 = await run(`RADIIA SKU,Quantity\n${hoops.sku},3\n`);
  check("3 of 16 is accepted", r8.okCount === 1, r8.rows);
  check("the quantity rides on the line", r8.lines[0].quantity === 3, r8.lines[0]);
  check("and the sheet shows what is left", r8.rows[0].availableQty === 16, r8.rows[0]);

  const r8b = await run(`RADIIA SKU,Quantity\n${hoops.sku},20\n`);
  check("more than remains is refused", r8b.rows[0].state === "badQuantity", r8b.rows[0]);
  check("and says how many there are", (r8b.rows[0].error ?? "").includes("only 16"), r8b.rows[0].error);

  const r8c = await run(`RADIIA SKU,Quantity\n${hoops.sku},2.5\n`);
  check("a fractional piece count is refused", r8c.rows[0].state === "badQuantity", r8c.rows[0]);

  const r8d = await run(`RADIIA SKU,Quantity\n${ring.sku},3\n`);
  check("a quantity on a single piece is refused, not ignored", r8d.rows[0].state === "badQuantity", r8d.rows[0]);

  console.log("\n[9] an item already out cannot go out again");
  const sent = await createOutboundDocument(
    { type: "MEMO_OUT", clientId: store.id, inventoryItemIds: [ring.id] } as never,
    user.id
  );
  check("it goes out on a memo first", sent.ok, sent.ok ? undefined : sent.error);
  const r9 = await run(`RADIIA SKU\n${ring.sku}\n`);
  check("a second memo refuses it", r9.rows[0].state === "unavailable", r9.rows[0]);
  check("and says why in plain words", (r9.rows[0].error ?? "").includes("on memo"), r9.rows[0].error);
  const r9b = await run(`RADIIA SKU\n${ring.sku}\n`, "INVOICE");
  check("but an invoice accepts it — that is the sale", r9b.okCount === 1, r9b.rows[0]);

  console.log("\n[10] the sheet as Excel actually hands it over");
  const r10 = await run(
    `Reinstein Ross open stock\nprepared for RADIIA\n\nItem Name,RADIIA SKU,Vendor SKU (style #),Quantity\nSemi band,${band.sku},D100SEMI,2\n`
  );
  check("the header is found under the preamble", r10.okCount === 1, r10.rows);
  check("the row number points at their file", r10.rows[0].rowNumber === 5, r10.rows[0].rowNumber);
  check("and the quantity survives", r10.lines[0].quantity === 2, r10.lines[0]);

  console.log("\n[11] a sheet with nothing to match on");
  const r11 = await run(`Metal,Cost\n20k Peach,695\n`);
  check("it says so instead of matching nothing", r11.errorCount === 1, r11.rows);
  check("and names the columns it wanted", (r11.rows[0].error ?? "").includes("RADIIA SKU"), r11.rows[0].error);

  console.log("\n[12] brand scoping");
  const r12 = await run(`RADIIA SKU\n${band.sku}\n`, "MEMO_OUT", true);
  check("this brand's stock is found when scoped", r12.okCount === 1, r12.rows[0]);
  const other = await prisma.company.findFirst({ where: { name: `${PREFIX} Store` } });
  const r12b = await parseOutboundUpload({
    docType: "MEMO_OUT",
    csv: `RADIIA SKU\n${band.sku}\n`,
    brandOwnerId: other!.id
  });
  check("another brand's scope does not find it", r12b.rows[0].state === "notFound", r12b.rows[0]);
  check("and says the scope is why", (r12b.rows[0].error ?? "").includes("this brand's stock"), r12b.rows[0].error);

  console.log("\n[13] end to end — the matched lines make a real document");
  const r13 = await run(`RADIIA SKU,Quantity\n${hoops.sku},3\n${twin.sku},\n${band.sku},2\nRAD-99999,\n`);
  check("3 of 4 rows match", r13.okCount === 3 && r13.errorCount === 1, { ok: r13.okCount, err: r13.errorCount });
  const doc = await createOutboundDocument(
    { type: "MEMO_OUT", clientId: store.id, lines: r13.lines } as never,
    user.id
  );
  check("the memo is created from them", doc.ok, doc.ok ? undefined : doc.error);
  if (doc.ok) {
    const lineCount = await prisma.documentLineItem.count({ where: { documentId: doc.document.id } });
    check("with a line per matched row", lineCount === 3, lineCount);
    const a = await prisma.jewelryDetail.findUniqueOrThrow({ where: { inventoryItemId: hoops.id } });
    check("the 16-piece lot drew down by 3", a.remainingQty === 13, a.remainingQty);
    const item = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: hoops.id } });
    check("and stays IN_STOCK with 13 left", item.status === "IN_STOCK", item.status);
    const dband = await prisma.jewelryDetail.findUniqueOrThrow({ where: { inventoryItemId: band.id } });
    check("the 4-piece lot drew down by 2", dband.remainingQty === 2, dband.remainingQty);
    const twinItem = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: twin.id } });
    check("the single piece went whole", twinItem.status === "ON_MEMO", twinItem.status);
  }

  const clientIds = [store.id, brand.id];
  const docIds = (
    await prisma.document.findMany({ where: { clientId: { in: clientIds } }, select: { id: true } })
  ).map((d) => d.id);
  await prisma.documentLineItem.deleteMany({ where: { documentId: { in: docIds } } });
  await prisma.itemStatusHistory.deleteMany({ where: { inventoryItemId: { in: created } } });
  await prisma.document.deleteMany({ where: { id: { in: docIds } } });
  await prisma.inventoryItem.deleteMany({ where: { id: { in: created } } });
  await prisma.company.deleteMany({ where: { id: { in: clientIds } } }).catch(() => undefined);
  console.log(`\ncleaned up ${created.length} item(s), ${docIds.length} doc(s)`);

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
