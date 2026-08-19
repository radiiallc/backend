import { prisma } from "@/db";
import { createInboundDocument, createOutboundDocument, voidDocument } from "@/modules/ims/documents.service";
import { ImsCreateInboundDocumentSchema, type ImsInboundItemInput } from "@/contract";

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

function singleStone(sku: string, over: Record<string, unknown> = {}): ImsInboundItemInput {
  return {
    itemType: "STONE",
    itemSubtype: "SINGLE",
    sku,
    stone: {
      gemType: "Sapphire",
      shape: "Round",
      weightCt: 2,
      color: "Blue",
      costPerCt: 500,
      wholesalePricePerCt: 900,
      ...over
    }
  } as unknown as ImsInboundItemInput;
}

const SKUS = ["SMOKE-BIN-1", "SMOKE-BIN-2", "SMOKE-BIN-3", "SMOKE-BIN-4", "SMOKE-BIN-5"];

const VOID_REFS = ["DESIGNER-PACKING-VOID", "DESIGNER-PACKING-OUT"];

async function cleanupItems(): Promise<void> {
  const stale = await prisma.inventoryItem.findMany({
    where: { sku: { in: SKUS } },
    select: { id: true }
  });
  const ids = stale.map((s) => s.id);
  const docIds = new Set(
    ids.length
      ? (
          await prisma.documentLineItem.findMany({
            where: { inventoryItemId: { in: ids } },
            select: { documentId: true }
          })
        ).map((l) => l.documentId)
      : []
  );
  // A voided document's item is gone, so the sku-based lookup above can't find it —
  // catch those leftovers by their fixed externalReference instead.
  for (const doc of await prisma.document.findMany({
    where: { externalReference: { in: VOID_REFS } },
    select: { id: true }
  })) {
    docIds.add(doc.id);
  }
  const docIdList = Array.from(docIds);
  await prisma.documentLineItem.deleteMany({ where: { documentId: { in: docIdList } } });
  await prisma.itemStatusHistory.deleteMany({ where: { inventoryItemId: { in: ids } } });
  await prisma.inventoryItem.deleteMany({ where: { id: { in: ids } } });
  await prisma.document.deleteMany({ where: { id: { in: docIdList } } });
}

async function item(sku: string) {
  return prisma.inventoryItem.findFirstOrThrow({ where: { sku } });
}

async function main(): Promise<void> {
  const user = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
  const brand =
    (await prisma.company.findFirst({ where: { name: "SMOKE BrandIn Designer" } })) ??
    (await prisma.company.create({ data: { name: "SMOKE BrandIn Designer" } }));
  const store =
    (await prisma.company.findFirst({ where: { name: "SMOKE BrandIn Store" } })) ??
    (await prisma.company.create({ data: { name: "SMOKE BrandIn Store", clientStatus: "ACTIVE" } }));
  const vendor = await prisma.vendor.upsert({
    where: { name: "SMOKE BrandIn Vendor" },
    create: { name: "SMOKE BrandIn Vendor", defaultInvoiceTermsDays: 30 },
    update: {}
  });

  await cleanupItems();

  console.log("\n1. Brand In — designer's initial inventory");
  const bin = await createInboundDocument(
    {
      type: "BRAND_INVENTORY_IN",
      brandOwnerId: brand.id,
      externalReference: "DESIGNER-PACKING-7",
      items: [singleStone("SMOKE-BIN-1"), singleStone("SMOKE-BIN-2", { weightCt: 3 })]
    },
    user.id
  );
  check("brand in ok", bin.ok, bin.ok ? undefined : bin.error);

  const binDoc = await prisma.document.findFirstOrThrow({
    where: { externalReference: "DESIGNER-PACKING-7", type: "BRAND_INVENTORY_IN" }
  });
  check("mints a BIN-#### number", /^BIN-\d+$/.test(binDoc.documentNumber ?? ""), binDoc.documentNumber);
  check("addressed to the brand owner (clientId)", binDoc.clientId === brand.id, binDoc.clientId);
  check("no vendor on a brand in", binDoc.vendorId === null, binDoc.vendorId);
  check("no due date on a brand in", binDoc.dueDate === null, binDoc.dueDate);
  check("keeps the designer's own reference", binDoc.externalReference === "DESIGNER-PACKING-7");
  if (bin.ok) {
    check("DTO direction = in", bin.document.direction === "in", bin.document.direction);
    check("DTO party = brand owner name", bin.document.partyName === "SMOKE BrandIn Designer", bin.document.partyName);
  }

  const it1 = await item("SMOKE-BIN-1");
  check("item tagged to the brand owner", it1.brandOwnerId === brand.id, it1.brandOwnerId);
  check("item carries NO vendor", it1.vendorId === null, it1.vendorId);
  check("item enters IN_STOCK", it1.status === "IN_STOCK", it1.status);
  const hist = await prisma.itemStatusHistory.findFirst({
    where: { inventoryItemId: it1.id, documentId: binDoc.id }
  });
  check("null -> IN_STOCK audit row points at the brand in", !!hist && hist.previousStatus === null && hist.newStatus === "IN_STOCK", hist);

  console.log("\n2. Memo Out then Invoice on the brand's stock");
  const memo = await createOutboundDocument(
    { type: "MEMO_OUT", clientId: store.id, inventoryItemIds: [it1.id] },
    user.id
  );
  check("memo out ok", memo.ok, memo.ok ? undefined : memo.error);
  check("brand item is now ON_MEMO", (await item("SMOKE-BIN-1")).status === "ON_MEMO");
  const it2 = await item("SMOKE-BIN-2");
  const inv = await createOutboundDocument(
    { type: "INVOICE", clientId: store.id, inventoryItemIds: [it2.id] },
    user.id
  );
  check("invoice ok", inv.ok, inv.ok ? undefined : inv.error);
  check("brand item is now SOLD", (await item("SMOKE-BIN-2")).status === "SOLD");
  check("sold item stays tagged to the brand owner", (await item("SMOKE-BIN-2")).brandOwnerId === brand.id);

  console.log("\n3. Bill In regression (vendor-owned)");
  const bill = await createInboundDocument(
    { type: "BILL_IN", vendorId: vendor.id, externalReference: "VEND-BILL-9", items: [singleStone("SMOKE-BIN-3")] },
    user.id
  );
  check("bill in ok", bill.ok, bill.ok ? undefined : bill.error);
  const it3 = await item("SMOKE-BIN-3");
  check("bill-in item inherits the vendor", it3.vendorId === vendor.id, it3.vendorId);
  check("bill-in item has NO brand owner", it3.brandOwnerId === null, it3.brandOwnerId);
  const billDoc = await prisma.document.findFirstOrThrow({ where: { externalReference: "VEND-BILL-9" } });
  check("bill in mints no internal number", billDoc.documentNumber === null, billDoc.documentNumber);
  check("bill in due date from vendor terms (+30d)", billDoc.dueDate !== null, billDoc.dueDate);

  console.log("\n4. Guards");
  const ghost = await createInboundDocument(
    { type: "BRAND_INVENTORY_IN", brandOwnerId: "does-not-exist", items: [singleStone("SMOKE-BIN-X")] },
    user.id
  );
  check("unknown brand owner rejected", !ghost.ok && ghost.error === "Brand owner not found", ghost);

  const items = [singleStone("SMOKE-BIN-Z")];
  check(
    "brand in WITHOUT a brand owner is rejected",
    !ImsCreateInboundDocumentSchema.safeParse({ type: "BRAND_INVENTORY_IN", items }).success
  );
  check(
    "brand in WITH a vendor is rejected",
    !ImsCreateInboundDocumentSchema.safeParse({ type: "BRAND_INVENTORY_IN", brandOwnerId: "b", vendorId: "v", items }).success
  );
  check(
    "bill in WITHOUT a vendor is rejected",
    !ImsCreateInboundDocumentSchema.safeParse({ type: "BILL_IN", items }).success
  );
  check(
    "bill in WITH a brand owner is rejected",
    !ImsCreateInboundDocumentSchema.safeParse({ type: "BILL_IN", vendorId: "v", brandOwnerId: "b", items }).success
  );
  check(
    "a valid brand in passes the schema",
    ImsCreateInboundDocumentSchema.safeParse({ type: "BRAND_INVENTORY_IN", brandOwnerId: "b", items }).success
  );

  console.log("\n5. Brand In void — the undo, items removed from inventory");
  const binVoid = await createInboundDocument(
    {
      type: "BRAND_INVENTORY_IN",
      brandOwnerId: brand.id,
      externalReference: "DESIGNER-PACKING-VOID",
      items: [singleStone("SMOKE-BIN-4")]
    },
    user.id
  );
  check("brand in (to void) ok", binVoid.ok, binVoid.ok ? undefined : binVoid.error);
  const binVoidDoc = await prisma.document.findFirstOrThrow({
    where: { externalReference: "DESIGNER-PACKING-VOID", type: "BRAND_INVENTORY_IN" }
  });
  const voided = await voidDocument(binVoidDoc.id, user.id);
  check("brand in void ok", voided.ok, voided.ok ? undefined : voided.error);
  check(
    "voided brand in document is VOID",
    voided.ok && voided.document.status === "VOID",
    voided.ok ? voided.document.status : voided.error
  );
  const goneItem = await prisma.inventoryItem.findFirst({ where: { sku: "SMOKE-BIN-4" } });
  check("voided brand in item removed from inventory", goneItem === null, goneItem);

  console.log("\n6. Brand Inventory Out — returning stock to the brand");
  const binOut = await createInboundDocument(
    {
      type: "BRAND_INVENTORY_IN",
      brandOwnerId: brand.id,
      externalReference: "DESIGNER-PACKING-OUT",
      items: [singleStone("SMOKE-BIN-5")]
    },
    user.id
  );
  check("brand in (to return) ok", binOut.ok, binOut.ok ? undefined : binOut.error);
  const it5 = await item("SMOKE-BIN-5");
  const brandOut = await createOutboundDocument(
    { type: "BRAND_INVENTORY_OUT", clientId: brand.id, inventoryItemIds: [it5.id] },
    user.id
  );
  check("brand out ok", brandOut.ok, brandOut.ok ? undefined : brandOut.error);
  if (brandOut.ok) {
    check("mints a BOU-#### number", /^BOU-\d+$/.test(brandOut.document.documentNumber ?? ""), brandOut.document.documentNumber);
    check("brand out document is CLOSED immediately", brandOut.document.status === "CLOSED", brandOut.document.status);
    check("brand out addressed to the brand owner", brandOut.document.clientId === brand.id, brandOut.document.clientId);
  }
  check("returned item status is RETURNED", (await item("SMOKE-BIN-5")).status === "RETURNED");
  check("returned item stays tagged to the brand owner", (await item("SMOKE-BIN-5")).brandOwnerId === brand.id);

  console.log("\n7. Brand Out ownership guard");
  const it3ForGuard = await item("SMOKE-BIN-3");
  const wrongOwner = await createOutboundDocument(
    { type: "BRAND_INVENTORY_OUT", clientId: brand.id, inventoryItemIds: [it3ForGuard.id] },
    user.id
  );
  check("returning a non-brand-owned item is rejected", !wrongOwner.ok, wrongOwner);

  await cleanupItems();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("failures:", failures.join(", "));
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
