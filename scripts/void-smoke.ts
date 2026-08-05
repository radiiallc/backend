// Void / delete smoke (Jennifer #0049) — the undo for a mistaken document, and
// the delete for one that should not exist at all. Runs against radiia_dev at
// the service layer. Run: npm run smoke:void
//
// The refusals are the point of this file, not the happy paths: voiding a
// RECEIPT deletes the stock it created, so every guard that stands between that
// and a Bill In whose goods have already moved is asserted on its message text.
import { prisma } from "@/db";
import {
  createInboundDocument,
  createOutboundDocument,
  createPurchaseOrder,
  deleteDocument,
  recordMemoReturn,
  voidDocument
} from "@/modules/ims/documents.service";
import { adjustParcelRemaining, reserveItem } from "@/modules/ims/inventory.service";
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
      gemType: "Ruby",
      shape: "Round",
      weightCt: 2,
      quantity: 1,
      color: "Red",
      costPerCt: 100,
      wholesalePricePerCt: 200,
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

const PREFIX = "SMOKE-VD-";

// Run at both ends: at the start so a crashed previous run can't poison this
// one, and at the end so dev inventory isn't left with smoke fixtures in it.
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
  // Voided receipts leave a document with no lines and no items, so they can
  // only be found by their own reference.
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
    // Children (returns) first: parentDocumentId is restrict-on-delete.
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

async function main(): Promise<void> {
  const user = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
  const vendor = await prisma.vendor.upsert({
    where: { name: "SMOKE Void Vendor" },
    create: { name: "SMOKE Void Vendor" },
    update: {}
  });
  // ACTIVE matters: reserving for an inactive client is refused upstream, and
  // section 3 needs a real reservation to test against.
  const client =
    (await prisma.company.findFirst({ where: { name: "SMOKE Void Client" } })) ??
    (await prisma.company.create({ data: { name: "SMOKE Void Client", clientStatus: "ACTIVE" } }));
  if (client.clientStatus !== "ACTIVE") {
    await prisma.company.update({ where: { id: client.id }, data: { clientStatus: "ACTIVE" } });
  }

  const cleaned = await cleanup();
  if (cleaned > 0) console.log(`(cleaned ${cleaned} stale fixture item(s))`);

  const bill = async (ref: string, items: ImsInboundItemInput[]) => {
    const r = await createInboundDocument(
      { type: "BILL_IN", vendorId: vendor.id, externalReference: PREFIX + ref, items },
      user.id
    );
    if (!r.ok) throw new Error(`fixture Bill In ${ref} failed: ${r.error}`);
    return r.document;
  };

  // ── 1. void a receipt: the stock it created is removed ────────────────────
  console.log("\n1. void a Bill In (happy path)");
  const d1 = await bill("1", [single(PREFIX + "1a"), single(PREFIX + "1b")]);
  check("two items received", (await itemBySku(PREFIX + "1a")) !== null);
  const v1 = await voidDocument(d1.id, user.id);
  check("void ok", v1.ok, v1.ok ? undefined : v1.error);
  check("item 1a gone from inventory", (await itemBySku(PREFIX + "1a")) === null);
  check("item 1b gone from inventory", (await itemBySku(PREFIX + "1b")) === null);
  const after1 = await prisma.document.findUniqueOrThrow({
    where: { id: d1.id },
    include: { lineItems: true }
  });
  check("document kept, marked VOID", after1.status === "VOID", after1.status);
  check("lines removed with the stock", after1.lineItems.length === 0);
  check(
    "notes record what was undone",
    (after1.notes || "").includes("2 received item(s) removed"),
    after1.notes
  );
  const orphanHistory = await prisma.itemStatusHistory.count({ where: { documentId: d1.id } });
  check("no orphan audit rows left behind", orphanHistory === 0, { orphanHistory });

  const v1again = await voidDocument(d1.id, user.id);
  check(
    "voiding twice refuses",
    !v1again.ok && v1again.error === "Document is already void",
    v1again.ok ? "accepted" : v1again.error
  );

  // ── 2. refused once the goods have moved ──────────────────────────────────
  console.log("\n2. a receipt whose items have moved cannot be voided");
  const d2 = await bill("2", [single(PREFIX + "2a")]);
  const it2 = await itemBySku(PREFIX + "2a");
  const sale = await createOutboundDocument(
    { type: "INVOICE", clientId: client.id, lines: [{ inventoryItemId: it2!.id }] },
    user.id
  );
  check("test sale created", sale.ok, sale.ok ? undefined : sale.error);
  const v2 = await voidDocument(d2.id, user.id);
  check("void refused", !v2.ok, v2.ok ? "accepted" : undefined);
  // The status guard answers first here (SOLD), which is the more specific of
  // the two reasons — either way the sentence must name the item and the fix.
  check(
    "refusal names the SKU and the reason",
    !v2.ok && v2.error.includes(PREFIX + "2a") && v2.error.includes("sold"),
    v2.ok ? "" : v2.error
  );
  check("nothing was deleted", (await itemBySku(PREFIX + "2a")) !== null);

  // ── 3. refused while an item is reserved ──────────────────────────────────
  console.log("\n3. a reserved item blocks the void");
  const d3 = await bill("3", [single(PREFIX + "3a")]);
  const it3 = await itemBySku(PREFIX + "3a");
  const res3 = await reserveItem(it3!.id, client.id, user.id);
  check("reserve ok", res3.ok, res3.ok ? undefined : res3.error);
  const v3 = await voidDocument(d3.id, user.id);
  // RESERVED is not IN_STOCK, so the status guard is what answers first — the
  // sentence still has to name the item and tell the operator what to do.
  check(
    "void refused, naming the item",
    !v3.ok && v3.error.includes(PREFIX + "3a"),
    v3.ok ? "accepted" : v3.error
  );

  // ── 4. refused once a parcel has been drawn against ───────────────────────
  console.log("\n4. a drawn parcel blocks the void (status never changed)");
  const d4 = await bill("4", [parcel(PREFIX + "4a", 10)]);
  const it4 = await itemBySku(PREFIX + "4a");
  // Adjusted, not invoiced: a write-off/recount moves carats with no document,
  // so this is the case the status and other-document guards cannot see.
  const adj = await adjustParcelRemaining(
    it4!.id,
    { remainingCt: 9.5, remainingQty: 95, reason: "smoke: dust write-off" },
    user.id
  );
  check("adjust ok", adj.ok, adj.ok ? undefined : adj.error);
  const it4b = await itemBySku(PREFIX + "4a");
  check("still IN_STOCK after the draw", it4b!.status === "IN_STOCK", it4b!.status);
  const v4 = await voidDocument(d4.id, user.id);
  check(
    "void refused: already drawn against",
    !v4.ok && v4.error.includes("drawn against"),
    v4.ok ? "accepted" : v4.error
  );

  // ── 5. refused when the receipt topped up an existing lot ─────────────────
  console.log("\n5. a restock line blocks the void (cost was re-averaged)");
  await bill("5", [parcel(PREFIX + "5a", 10)]);
  const d5b = await bill("5b", [parcel(PREFIX + "5a", 5, { costPerCt: 200 })]);
  const v5 = await voidDocument(d5b.id, user.id);
  check(
    "void refused, naming the SKU",
    !v5.ok && v5.error.includes(PREFIX + "5a") && v5.error.includes("cost"),
    v5.ok ? "accepted" : v5.error
  );

  // ── 6. outbound void still returns stock (regression) ─────────────────────
  console.log("\n6. Memo Out / Invoice void puts stock back");
  const d6 = await bill("6", [single(PREFIX + "6a"), parcel(PREFIX + "6b", 10)]);
  const it6a = await itemBySku(PREFIX + "6a");
  const it6b = await itemBySku(PREFIX + "6b");
  const memo = await createOutboundDocument(
    { type: "MEMO_OUT", clientId: client.id, lines: [{ inventoryItemId: it6a!.id }] },
    user.id
  );
  check("memo out created", memo.ok, memo.ok ? undefined : memo.error);
  check("item is ON_MEMO", (await itemBySku(PREFIX + "6a"))!.status === "ON_MEMO");
  const v6 = memo.ok ? await voidDocument(memo.document.id, user.id) : null;
  check("memo void ok", !!v6?.ok, v6 && !v6.ok ? v6.error : undefined);
  check("item back IN_STOCK", (await itemBySku(PREFIX + "6a"))!.status === "IN_STOCK");

  const inv6 = await createOutboundDocument(
    { type: "INVOICE", clientId: client.id, lines: [{ inventoryItemId: it6b!.id, caratWeight: 4 }] },
    user.id
  );
  check("partial parcel invoice created", inv6.ok, inv6.ok ? undefined : inv6.error);
  check("remaining drawn to 6 ct", n((await itemBySku(PREFIX + "6b"))!.stone!.remainingCt) === 6);
  const v6b = inv6.ok ? await voidDocument(inv6.document.id, user.id) : null;
  check("invoice void ok", !!v6b?.ok, v6b && !v6b.ok ? v6b.error : undefined);
  check(
    "carats restored to 10",
    n((await itemBySku(PREFIX + "6b"))!.stone!.remainingCt) === 10
  );
  check("the receipt is voidable again once its items are free", (await voidDocument(d6.id, user.id)).ok);

  // ── 7. a Purchase Order voids without touching stock ──────────────────────
  console.log("\n7. Purchase Order void moves no stock");
  const d7 = await bill("7", [parcel(PREFIX + "7a", 10)]);
  const it7 = await itemBySku(PREFIX + "7a");
  const po = await createPurchaseOrder(
    { vendorId: vendor.id, inventoryItemIds: [it7!.id] },
    user.id
  );
  check("PO created", po.ok, po.ok ? undefined : po.error);
  // The item never left stock, so only the other-document guard can catch this:
  // an open order against goods the receipt is about to delete.
  const v7pre = await voidDocument(d7.id, user.id);
  check(
    "receipt refuses while a live PO names its item",
    !v7pre.ok && v7pre.error.includes("another document"),
    v7pre.ok ? "accepted" : v7pre.error
  );
  const v7 = po.ok ? await voidDocument(po.document.id, user.id) : null;
  check("PO void ok", !!v7?.ok, v7 && !v7.ok ? v7.error : undefined);
  const it7b = await itemBySku(PREFIX + "7a");
  check("parcel balance untouched by the PO void", n(it7b!.stone!.remainingCt) === 10, {
    remaining: n(it7b!.stone!.remainingCt)
  });
  check("item still IN_STOCK", it7b!.status === "IN_STOCK");
  // Nothing else holds the parcel now, so the receipt clears — the sequence
  // Jennifer actually needs: void what came after, then void the receipt.
  const v7post = await voidDocument(d7.id, user.id);
  check("receipt voidable once the PO is void", v7post.ok, v7post.ok ? undefined : v7post.error);

  // ── 8. a return document cannot be voided ─────────────────────────────────
  console.log("\n8. return documents refuse by name");
  const d8 = await bill("8", [single(PREFIX + "8a")]);
  const it8 = await itemBySku(PREFIX + "8a");
  const memo8 = await createOutboundDocument(
    { type: "MEMO_OUT", clientId: client.id, lines: [{ inventoryItemId: it8!.id }] },
    user.id
  );
  const ret8 = memo8.ok ? await recordMemoReturn(memo8.document.id, {}, user.id) : null;
  check("return recorded", !!ret8?.ok, ret8 && !ret8.ok ? ret8.error : undefined);
  if (ret8?.ok) {
    const v8 = await voidDocument(ret8.returnDocument.id, user.id);
    check(
      "return void refused",
      !v8.ok && v8.error.includes("cannot be voided"),
      v8.ok ? "accepted" : v8.error
    );
    const v8memo = await voidDocument(memo8.ok ? memo8.document.id : "", user.id);
    check(
      "the memo underneath it refuses too",
      !v8memo.ok && v8memo.error.includes("return"),
      v8memo.ok ? "accepted" : v8memo.error
    );
  }
  void d8;

  // ── 9. delete: only once the document holds nothing ───────────────────────
  console.log("\n9. delete refuses while stock is held, allows after a void");
  const d9 = await bill("9", [single(PREFIX + "9a")]);
  const del9 = await deleteDocument(d9.id);
  check(
    "delete refused: holding stock, void first",
    !del9.ok && del9.error.includes("void it first"),
    del9.ok ? "accepted" : del9.error
  );
  check("item survived the refusal", (await itemBySku(PREFIX + "9a")) !== null);
  const v9 = await voidDocument(d9.id, user.id);
  check("void ok", v9.ok, v9.ok ? undefined : v9.error);
  const del9b = await deleteDocument(d9.id);
  check("delete allowed once void", del9b.ok, del9b.ok ? undefined : del9b.error);
  check(
    "document is gone",
    (await prisma.document.findUnique({ where: { id: d9.id } })) === null
  );

  // ── 10. delete refuses under a return ─────────────────────────────────────
  console.log("\n10. delete refuses a document with a return against it");
  if (memo8.ok) {
    const del10 = await deleteDocument(memo8.document.id);
    check(
      "refused: delete the return first",
      !del10.ok && del10.error.includes("return"),
      del10.ok ? "accepted" : del10.error
    );
  }
  const del11 = await deleteDocument("no-such-document-id");
  check(
    "unknown id refuses cleanly",
    !del11.ok && del11.error === "Document not found",
    del11.ok ? "accepted" : del11.error
  );

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
