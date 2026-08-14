import { prisma } from "@/db";
import { createInboundDocument, createOutboundDocument } from "@/modules/ims/documents.service";
import type { ImsInboundItemInput } from "@/contract";

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

const n = (d: unknown): number | null =>
  d === null || d === undefined ? null : Number(String(d));

async function stone(sku: string) {
  const it = await prisma.inventoryItem.findFirstOrThrow({
    where: { sku },
    include: { stone: true }
  });
  return {
    id: it.id,
    status: it.status,
    weightCt: n(it.stone?.weightCt),
    quantity: it.stone?.quantity ?? null,
    remainingCt: n(it.stone?.remainingCt),
    remainingQty: it.stone?.remainingQty ?? null,
    costPerCt: n(it.stone?.costPerCt),
    wholesalePricePerCt: n(it.stone?.wholesalePricePerCt),
    totalCost: n(it.stone?.totalCost)
  };
}

function parcel(sku: string, weightCt: number, over: Partial<Record<string, unknown>> = {}) {
  return {
    itemType: "STONE",
    itemSubtype: "PARCEL",
    sku,
    stone: {
      gemType: "Ruby",
      shape: "Round",
      weightCt,
      quantity: 100,
      color: "Red",
      costPerCt: 100,
      wholesalePricePerCt: 200,
      ...over
    }
  } as unknown as ImsInboundItemInput;
}

const SKUS = ["SMOKE-RS-1", "SMOKE-RS-2", "SMOKE-RS-3", "SMOKE-RS-SINGLE"];

async function cleanup(): Promise<number> {
  const stale = await prisma.inventoryItem.findMany({
    where: { sku: { in: SKUS } },
    select: { id: true }
  });
  if (stale.length === 0) return 0;
  const ids = stale.map((s) => s.id);
  const docIds = (
    await prisma.documentLineItem.findMany({
      where: { inventoryItemId: { in: ids } },
      select: { documentId: true }
    })
  ).map((l) => l.documentId);
  await prisma.documentLineItem.deleteMany({ where: { inventoryItemId: { in: ids } } });
  await prisma.itemStatusHistory.deleteMany({ where: { inventoryItemId: { in: ids } } });
  await prisma.inventoryItem.deleteMany({ where: { id: { in: ids } } });
  await prisma.document.deleteMany({ where: { id: { in: docIds } } });
  return ids.length;
}

async function main(): Promise<void> {
  const user = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
  const vendorA = await prisma.vendor.upsert({
    where: { name: "SMOKE Restock Vendor A" },
    create: { name: "SMOKE Restock Vendor A" },
    update: {}
  });
  const vendorB = await prisma.vendor.upsert({
    where: { name: "SMOKE Restock Vendor B" },
    create: { name: "SMOKE Restock Vendor B" },
    update: {}
  });
  const client =
    (await prisma.company.findFirst({ where: { name: "SMOKE Restock Client" } })) ??
    (await prisma.company.create({ data: { name: "SMOKE Restock Client" } }));

  await cleanup();

  console.log("\n1. first receipt");
  const first = await createInboundDocument(
    { type: "BILL_IN", vendorId: vendorA.id, items: [parcel("SMOKE-RS-1", 10)] },
    user.id
  );
  check("first receipt ok", first.ok, first.ok ? undefined : first.error);
  let s = await stone("SMOKE-RS-1");
  check("lot = 10 ct", s.weightCt === 10, s);
  check("remaining = 10 ct", s.remainingCt === 10, s);
  check("qty = 100", s.quantity === 100, s);

  console.log("\n2. restock same SKU (used to be a hard error)");
  const second = await createInboundDocument(
    {
      type: "BILL_IN",
      vendorId: vendorA.id,
      items: [parcel("SMOKE-RS-1", 5, { costPerCt: 200, wholesalePricePerCt: 300 })]
    },
    user.id
  );
  check("restock accepted", second.ok, second.ok ? undefined : second.error);
  s = await stone("SMOKE-RS-1");
  check("lot grew to 15 ct", s.weightCt === 15, s);
  check("remaining grew to 15 ct", s.remainingCt === 15, s);
  check("qty summed to 200", s.quantity === 200, s);
  check("cost re-averaged to 133.33", s.costPerCt === 133.33, s);
  check("newest list price wins (300)", s.wholesalePricePerCt === 300, s);
  check("totalCost = 15 × 133.33", s.totalCost === 1999.95, s);

  const onlyOne = await prisma.inventoryItem.count({ where: { sku: "SMOKE-RS-1" } });
  check("still exactly one row for the SKU", onlyOne === 1, { onlyOne });

  if (second.ok) {
    const doc = await prisma.document.findUniqueOrThrow({
      where: { id: second.document.id },
      include: { lineItems: true }
    });
    check("line carries the 5 ct received", n(doc.lineItems[0].caratWeight) === 5, doc.lineItems[0]);
    check("line priced at the new cost (5 × 200)", n(doc.lineItems[0].totalPrice) === 1000, doc.lineItems[0]);
  }

  console.log("\n3. restock after a partial sale");
  await createInboundDocument(
    { type: "BILL_IN", vendorId: vendorA.id, items: [parcel("SMOKE-RS-2", 20)] },
    user.id
  );
  const s2 = await stone("SMOKE-RS-2");
  const sale = await createOutboundDocument(
    {
      type: "INVOICE",
      clientId: client.id,
      lines: [{ inventoryItemId: s2.id, caratWeight: 8 }]
    },
    user.id
  );
  check("partial sale ok", sale.ok, sale.ok ? undefined : sale.error);
  let s2b = await stone("SMOKE-RS-2");
  check("remaining 12 of 20 after sale", s2b.remainingCt === 12 && s2b.weightCt === 20, s2b);

  const top = await createInboundDocument(
    { type: "BILL_IN", vendorId: vendorA.id, items: [parcel("SMOKE-RS-2", 6)] },
    user.id
  );
  check("restock on a part-sold parcel ok", top.ok, top.ok ? undefined : top.error);
  s2b = await stone("SMOKE-RS-2");
  check("lot 20 -> 26", s2b.weightCt === 26, s2b);
  check("balance 12 -> 18 (sold carats stay sold)", s2b.remainingCt === 18, s2b);

  console.log("\n4. restocking a SOLD-out lot");
  await createInboundDocument(
    { type: "BILL_IN", vendorId: vendorA.id, items: [parcel("SMOKE-RS-3", 4)] },
    user.id
  );
  const s3 = await stone("SMOKE-RS-3");
  await createOutboundDocument(
    { type: "INVOICE", clientId: client.id, lines: [{ inventoryItemId: s3.id }] },
    user.id
  );
  let s3b = await stone("SMOKE-RS-3");
  check("parcel is SOLD and empty", s3b.status === "SOLD" && s3b.remainingCt === 0, s3b);

  const revive = await createInboundDocument(
    { type: "BILL_IN", vendorId: vendorB.id, items: [parcel("SMOKE-RS-3", 3)] },
    user.id
  );
  check("restock of a sold-out lot ok", revive.ok, revive.ok ? undefined : revive.error);
  s3b = await stone("SMOKE-RS-3");
  check("back IN_STOCK", s3b.status === "IN_STOCK", s3b);
  check("balance = the 3 ct just received", s3b.remainingCt === 3, s3b);
  const audit = await prisma.itemStatusHistory.findFirst({
    where: { inventoryItemId: s3b.id, previousStatus: "SOLD", newStatus: "IN_STOCK" },
    orderBy: { changedAt: "desc" }
  });
  check("SOLD -> IN_STOCK audited against the bill", audit !== null && audit.documentId !== null);

  console.log("\n5. guards");
  const single = await createInboundDocument(
    {
      type: "BILL_IN",
      vendorId: vendorA.id,
      items: [
        {
          itemType: "STONE",
          itemSubtype: "SINGLE",
          sku: "SMOKE-RS-SINGLE",
          stone: { gemType: "Ruby", shape: "Oval", weightCt: 2, color: "Red", costPerCt: 500 }
        } as unknown as ImsInboundItemInput
      ]
    },
    user.id
  );
  check("single stone received", single.ok, single.ok ? undefined : single.error);

  const singleAgain = await createInboundDocument(
    {
      type: "BILL_IN",
      vendorId: vendorA.id,
      items: [
        {
          itemType: "STONE",
          itemSubtype: "SINGLE",
          sku: "SMOKE-RS-SINGLE",
          stone: { gemType: "Ruby", shape: "Oval", weightCt: 3, color: "Red", costPerCt: 500 }
        } as unknown as ImsInboundItemInput
      ]
    },
    user.id
  );
  check(
    "an individual stone still refuses to merge",
    !singleAgain.ok && /cannot be topped up/.test(singleAgain.ok ? "" : singleAgain.error),
    singleAgain.ok ? "accepted" : singleAgain.error
  );

  const dupes = await createInboundDocument(
    {
      type: "BILL_IN",
      vendorId: vendorA.id,
      items: [parcel("SMOKE-RS-1", 1), parcel("SMOKE-RS-1", 2)]
    },
    user.id
  );
  check(
    "same SKU twice in ONE upload is still rejected",
    !dupes.ok && /more than once/.test(dupes.ok ? "" : dupes.error),
    dupes.ok ? "accepted" : dupes.error
  );

  const typeClash = await createInboundDocument(
    {
      type: "BILL_IN",
      vendorId: vendorA.id,
      items: [
        {
          itemType: "JEWELRY",
          sku: "SMOKE-RS-1",
          jewelry: { jewelryItemType: "Ring", quantity: 1, metal: "18K", productionCost: 10 }
        } as unknown as ImsInboundItemInput
      ]
    },
    user.id
  );
  check(
    "same SKU, different item type is rejected",
    !typeClash.ok && /different goods/.test(typeClash.ok ? "" : typeClash.error),
    typeClash.ok ? "accepted" : typeClash.error
  );

  const afterGuards = await stone("SMOKE-RS-1");
  check("rejected uploads wrote nothing", afterGuards.weightCt === 15, afterGuards);

  console.log("\n6. weight-without-piece-count");
  const noQty = await createInboundDocument(
    {
      type: "BILL_IN",
      vendorId: vendorA.id,
      items: [parcel("SMOKE-RS-1", 5, { quantity: undefined })]
    },
    user.id
  );
  check("carat-only restock ok", noQty.ok, noQty.ok ? undefined : noQty.error);
  const s1c = await stone("SMOKE-RS-1");
  check("lot 15 -> 20 ct", s1c.weightCt === 20, s1c);
  check("piece count becomes unknown, not wrong", s1c.quantity === null, s1c);

  const removed = await cleanup();
  console.log(`\ncleaned up ${removed} item(s)`);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log(`failures: ${failures.join(", ")}`);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
