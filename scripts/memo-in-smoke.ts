import { prisma } from "@/db";
import {
  createInboundDocument,
  createOutboundDocument,
  recordVendorReturn,
  voidDocument
} from "@/modules/ims/documents.service";
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

function single(sku: string, over: Record<string, unknown> = {}) {
  return {
    itemType: "STONE",
    itemSubtype: "SINGLE",
    sku,
    stone: {
      gemType: "Sapphire",
      shape: "Oval",
      weightCt: 3,
      quantity: 1,
      color: "Blue",
      costPerCt: 150,
      wholesalePricePerCt: 300,
      ...over
    }
  } as unknown as ImsInboundItemInput;
}

function parcel(sku: string, weightCt: number, over: Record<string, unknown> = {}) {
  return {
    itemType: "STONE",
    itemSubtype: "PARCEL",
    sku,
    stone: {
      gemType: "Sapphire",
      shape: "Round",
      weightCt,
      quantity: 50,
      color: "Blue",
      costPerCt: 80,
      wholesalePricePerCt: 160,
      ...over
    }
  } as unknown as ImsInboundItemInput;
}

const PREFIX = "SMOKE-MIR-";

async function cleanup(): Promise<number> {
  const stale = await prisma.inventoryItem.findMany({
    where: { sku: { startsWith: PREFIX } },
    select: { id: true }
  });
  const ids = stale.map((s) => s.id);
  const docIds = new Set<string>();
  if (ids.length > 0) {
    for (const l of await prisma.documentLineItem.findMany({
      where: { inventoryItemId: { in: ids } },
      select: { documentId: true }
    })) {
      docIds.add(l.documentId);
    }
  }
  for (const d of await prisma.document.findMany({
    where: { externalReference: { startsWith: PREFIX } },
    select: { id: true }
  })) {
    docIds.add(d.id);
  }
  const docList = [...docIds];
  if (ids.length > 0) {
    await prisma.documentLineItem.deleteMany({ where: { inventoryItemId: { in: ids } } });
    await prisma.itemStatusHistory.deleteMany({ where: { inventoryItemId: { in: ids } } });
  }
  if (docList.length > 0) {
    await prisma.documentLineItem.deleteMany({ where: { documentId: { in: docList } } });
    await prisma.itemStatusHistory.deleteMany({ where: { documentId: { in: docList } } });
    await prisma.document.deleteMany({ where: { parentDocumentId: { in: docList } } });
  }
  if (ids.length > 0) await prisma.inventoryItem.deleteMany({ where: { id: { in: ids } } });
  if (docList.length > 0) await prisma.document.deleteMany({ where: { id: { in: docList } } });
  return ids.length;
}

async function itemBySku(sku: string) {
  return prisma.inventoryItem.findFirst({ where: { sku }, include: { stone: true } });
}

async function docWithLines(id: string) {
  return prisma.document.findUniqueOrThrow({ where: { id }, include: { lineItems: true } });
}

async function main(): Promise<void> {
  const user = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
  const vendor = await prisma.vendor.upsert({
    where: { name: "SMOKE MemoIn Vendor" },
    create: { name: "SMOKE MemoIn Vendor" },
    update: {}
  });
  const client =
    (await prisma.company.findFirst({ where: { name: "SMOKE MemoIn Client" } })) ??
    (await prisma.company.create({ data: { name: "SMOKE MemoIn Client", clientStatus: "ACTIVE" } }));
  if (client.clientStatus !== "ACTIVE") {
    await prisma.company.update({ where: { id: client.id }, data: { clientStatus: "ACTIVE" } });
  }

  const cleaned = await cleanup();
  if (cleaned > 0) console.log(`(cleaned ${cleaned} stale fixture item(s))`);

  const memoIn = async (ref: string, items: ImsInboundItemInput[]) => {
    const r = await createInboundDocument(
      { type: "MEMO_IN", vendorId: vendor.id, externalReference: PREFIX + ref, items },
      user.id
    );
    if (!r.ok) throw new Error(`fixture Memo In ${ref} failed: ${r.error}`);
    return r.document;
  };

  console.log("\n1. receive a Memo In (single + single + parcel)");
  const m1 = await memoIn("1", [
    single(PREFIX + "1a"),
    single(PREFIX + "1b"),
    parcel(PREFIX + "1c", 10)
  ]);
  check("Memo In minted, OPEN", m1.status === "OPEN", m1.status);
  const it1a = await itemBySku(PREFIX + "1a");
  check("item 1a IN_STOCK, vendor-tagged", it1a!.status === "IN_STOCK" && it1a!.vendorId === vendor.id);
  const m1doc = await docWithLines(m1.id);
  check(
    "all 3 lines start IN_STOCK",
    m1doc.lineItems.every((l) => l.lineStatus === "IN_STOCK"),
    m1doc.lineItems.map((l) => l.lineStatus)
  );

  console.log("\n2. return one single stone (explicit item)");
  const it1b = await itemBySku(PREFIX + "1b");
  const r2 = await recordVendorReturn(m1.id, { inventoryItemIds: [it1b!.id] }, user.id);
  check("return ok", r2.ok, r2.ok ? undefined : r2.error);
  if (r2.ok) {
    check("RET- prefix minted", r2.returnDocument.documentNumber?.startsWith("RET-") ?? false);
    check("return doc CLOSED", r2.returnDocument.status === "CLOSED");
    check("return doc addressed to the vendor", r2.returnDocument.vendorId === vendor.id);
    check("return doc parented to the Memo In", r2.returnDocument.parentDocumentId === m1.id);
    check("memo still OPEN (2 lines remain)", r2.memo.status === "OPEN", r2.memo.status);
  }
  const it1bAfter = await itemBySku(PREFIX + "1b");
  check("item 1b RETURNED", it1bAfter!.status === "RETURNED", it1bAfter!.status);
  const m1line1b = (await docWithLines(m1.id)).lineItems.find((l) => l.inventoryItemId === it1b!.id);
  check("original Memo In line 1b RETURNED", m1line1b?.lineStatus === "RETURNED");

  console.log("\n3. return the parcel in full (no partial-carat granularity)");
  const it1c = await itemBySku(PREFIX + "1c");
  const r3 = await recordVendorReturn(m1.id, { inventoryItemIds: [it1c!.id] }, user.id);
  check("parcel return ok", r3.ok, r3.ok ? undefined : r3.error);
  const it1cAfter = await itemBySku(PREFIX + "1c");
  check("parcel item RETURNED", it1cAfter!.status === "RETURNED", it1cAfter!.status);
  check("parcel remaining drawn to 0", n(it1cAfter!.stone!.remainingCt) === 0, n(it1cAfter!.stone!.remainingCt));

  console.log("\n4. invoicing the last item resolves its Memo In line to SOLD and closes the memo");
  const inv4 = await createOutboundDocument(
    { type: "INVOICE", clientId: client.id, lines: [{ inventoryItemId: it1a!.id }] },
    user.id
  );
  check("invoice created", inv4.ok, inv4.ok ? undefined : inv4.error);
  const m1final = await docWithLines(m1.id);
  const line1a = m1final.lineItems.find((l) => l.inventoryItemId === it1a!.id);
  check("Memo In line 1a resolved SOLD", line1a?.lineStatus === "SOLD", line1a?.lineStatus);
  check("Memo In fully closed", m1final.status === "CLOSED", m1final.status);
  check("close reason MIXED (returned + sold)", m1final.closeReason === "MIXED", m1final.closeReason);

  console.log("\n5. cannot return items not on this Memo In");
  const m5 = await memoIn("5", [single(PREFIX + "5a")]);
  const outsider = await itemBySku(PREFIX + "1a");
  const r5 = await recordVendorReturn(m5.id, { inventoryItemIds: [outsider!.id] }, user.id);
  check(
    "rejected — not on this memo",
    !r5.ok && r5.error.includes("Not currently available"),
    r5.ok ? "accepted" : r5.error
  );

  console.log("\n6. an item out on a client memo is skipped by 'return everything', rejected if named explicitly");
  const m6 = await memoIn("6", [single(PREFIX + "6a"), single(PREFIX + "6b")]);
  const it6a = await itemBySku(PREFIX + "6a");
  const it6b = await itemBySku(PREFIX + "6b");
  const memoOut6 = await createOutboundDocument(
    { type: "MEMO_OUT", clientId: client.id, lines: [{ inventoryItemId: it6a!.id }] },
    user.id
  );
  check("6a sent out on a client memo", memoOut6.ok, memoOut6.ok ? undefined : memoOut6.error);
  const r6all = await recordVendorReturn(m6.id, {}, user.id);
  check("return-all ok", r6all.ok, r6all.ok ? undefined : r6all.error);
  if (r6all.ok) {
    check(
      "only 6b (the free item) came back",
      r6all.returnDocument.lineItems.length === 1 &&
        r6all.returnDocument.lineItems[0]?.inventoryItemId === it6b!.id
    );
  }
  const r6explicit = await recordVendorReturn(m6.id, { inventoryItemIds: [it6a!.id] }, user.id);
  check(
    "explicit return of the out-on-memo item is rejected",
    !r6explicit.ok && r6explicit.error.includes("Not currently available"),
    r6explicit.ok ? "accepted" : r6explicit.error
  );

  console.log("\n7. a fully-returned memo closes with reason RETURNED");
  const m7 = await memoIn("7", [single(PREFIX + "7a"), single(PREFIX + "7b")]);
  const r7 = await recordVendorReturn(m7.id, {}, user.id);
  check("full return ok", r7.ok, r7.ok ? undefined : r7.error);
  check("memo CLOSED / reason RETURNED", r7.ok && r7.memo.status === "CLOSED" && r7.memo.closeReason === "RETURNED");

  console.log("\n8. a Return Memo In cannot be voided");
  if (r7.ok) {
    const v8 = await voidDocument(r7.returnDocument.id, user.id);
    check(
      "void refused",
      !v8.ok && v8.error.includes("cannot be voided"),
      v8.ok ? "accepted" : v8.error
    );
  }

  console.log("\ncleaning up…");
  await cleanup();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail > 0) {
    console.log("failed: " + failures.join(", "));
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
