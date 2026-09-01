/**
 * Moving stock from one memo straight onto another, and invoicing stock that is
 * out with somebody else.
 *
 * The thing being proved is that the new document does the old Return Memo Out's
 * work: exactly one memo may claim a piece at a time, and the carats or pieces
 * are never taken from the safe twice on the way across.
 */
import { prisma } from "@/db";
import { createOutboundDocument, recordMemoReturn } from "@/modules/ims/documents.service";
import { createInventoryItem } from "@/modules/ims/inventory.service";

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

const PREFIX = "SMOKE-XFER";

async function itemOf(id: string) {
  return prisma.inventoryItem.findUniqueOrThrow({
    where: { id },
    include: { stone: true, jewelry: true }
  });
}

async function lineOf(docId: string, itemId: string) {
  return prisma.documentLineItem.findFirstOrThrow({
    where: { documentId: docId, inventoryItemId: itemId }
  });
}

async function docOf(id: string) {
  return prisma.document.findUniqueOrThrow({ where: { id } });
}

async function main(): Promise<void> {
  const user = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
  const vendor = await prisma.vendor.upsert({
    where: { name: `${PREFIX} Vendor` },
    create: { name: `${PREFIX} Vendor` },
    update: {}
  });
  const company = async (name: string) =>
    (await prisma.company.findFirst({ where: { name: `${PREFIX} ${name}` } })) ??
    (await prisma.company.create({ data: { name: `${PREFIX} ${name}`, clientStatus: "ACTIVE" } }));
  const store = await company("Store");
  const stylist = await company("Stylist");
  const third = await company("Third");

  const created: string[] = [];
  async function ring(sku: string): Promise<string> {
    const res = await createInventoryItem({
      itemType: "JEWELRY",
      sku,
      vendorId: vendor.id,
      jewelry: {
        jewelryItemType: "Ring",
        metal: "20k Peach",
        quantity: 1,
        productionCost: 400,
        wholesalePrice: 900,
        retailPrice: 1400
      }
    } as never);
    if (!res.ok) throw new Error(`could not create ${sku}: ${res.error}`);
    created.push(res.item.id);
    return res.item.id;
  }
  async function lot(sku: string, quantity: number): Promise<string> {
    const res = await createInventoryItem({
      itemType: "JEWELRY",
      sku,
      vendorId: vendor.id,
      jewelry: {
        jewelryItemType: "Earrings",
        metal: "20k Peach",
        quantity,
        productionCost: 400,
        wholesalePrice: 1000,
        retailPrice: 1550
      }
    } as never);
    if (!res.ok) throw new Error(`could not create ${sku}: ${res.error}`);
    created.push(res.item.id);
    return res.item.id;
  }
  async function parcel(sku: string, ct: number): Promise<string> {
    const res = await createInventoryItem({
      itemType: "STONE",
      sku,
      vendorId: vendor.id,
      itemSubtype: "PARCEL",
      stone: {
        naturalOrLab: "NATURAL",
        gemType: "Ruby",
        shape: "Round",
        weightCt: ct,
        costPerCt: 100,
        wholesalePricePerCt: 200
      }
    } as never);
    if (!res.ok) throw new Error(`could not create ${sku}: ${res.error}`);
    created.push(res.item.id);
    return res.item.id;
  }

  const memoOut = (lines: unknown[], clientId: string) =>
    createOutboundDocument({ type: "MEMO_OUT", clientId, lines } as never, user.id);
  const invoice = (lines: unknown[], clientId: string) =>
    createOutboundDocument({ type: "INVOICE", clientId, lines } as never, user.id);

  console.log("\n[1] a whole piece moves from the store to the stylist");
  const a = await ring(`${PREFIX}-A`);
  const m1 = await memoOut([{ inventoryItemId: a }], store.id);
  check("it goes out to the store", m1.ok, m1.ok ? undefined : m1.error);
  if (!m1.ok) throw new Error("cannot continue");
  const m2 = await memoOut([{ inventoryItemId: a }], stylist.id);
  check("a second memo now accepts it", m2.ok, m2.ok ? undefined : m2.error);
  if (!m2.ok) throw new Error("cannot continue");
  check("the item is still ON_MEMO", (await itemOf(a)).status === "ON_MEMO");
  const oldLine = await lineOf(m1.document.id, a);
  check("the store's line reads RETURNED", oldLine.lineStatus === "RETURNED", oldLine.lineStatus);
  check(
    "and points at the memo that took it",
    oldLine.resolvedByDocumentId === m2.document.id,
    oldLine.resolvedByDocumentId
  );
  const oldDoc = await docOf(m1.document.id);
  check("the store's memo closed itself", oldDoc.status === "CLOSED", oldDoc.status);
  check("with a return as the reason", oldDoc.closeReason === "RETURNED", oldDoc.closeReason);
  const newLine = await lineOf(m2.document.id, a);
  check("the stylist's line is out", newLine.lineStatus === "ON_MEMO", newLine.lineStatus);
  check("priced at the full piece", Number(newLine.totalPrice) === 900, newLine.totalPrice);
  check("the stylist's memo is open", (await docOf(m2.document.id)).status === "OPEN");
  const hist = await prisma.itemStatusHistory.findMany({
    where: { inventoryItemId: a, documentId: m2.document.id }
  });
  check("the hand-off left a note on the item's history", (hist[0]?.note ?? "").includes("Moved from an open memo"), hist[0]?.note);

  console.log("\n[2] exactly one memo claims it at a time");
  const openLines = await prisma.documentLineItem.count({
    where: { inventoryItemId: a, lineStatus: "ON_MEMO" }
  });
  check("only one open memo line survives the move", openLines === 1, openLines);

  console.log("\n[3] it can move again, and the chain still holds");
  const m3 = await memoOut([{ inventoryItemId: a }], third.id);
  check("on to a third party", m3.ok, m3.ok ? undefined : m3.error);
  if (m3.ok) {
    check(
      "the stylist's line released too",
      (await lineOf(m2.document.id, a)).lineStatus === "RETURNED"
    );
    check(
      "still exactly one open claim",
      (await prisma.documentLineItem.count({
        where: { inventoryItemId: a, lineStatus: "ON_MEMO" }
      })) === 1
    );
    check("the stylist's memo closed", (await docOf(m2.document.id)).status === "CLOSED");
  }

  console.log("\n[4] invoicing what somebody else is holding");
  const b = await ring(`${PREFIX}-B`);
  const m4 = await memoOut([{ inventoryItemId: b }], store.id);
  check("out to the store first", m4.ok, m4.ok ? undefined : m4.error);
  const inv1 = await invoice([{ inventoryItemId: b }], stylist.id);
  check("a different client can buy it", inv1.ok, inv1.ok ? undefined : inv1.error);
  if (m4.ok && inv1.ok) {
    check("the item is SOLD", (await itemOf(b)).status === "SOLD");
    check("the store's line reads SOLD", (await lineOf(m4.document.id, b)).lineStatus === "SOLD");
    check("the store's memo closed", (await docOf(m4.document.id)).status === "CLOSED");
  }

  console.log("\n[5] a lot that is wholly out moves without drawing twice");
  const c = await lot(`${PREFIX}-C`, 12);
  const m5 = await memoOut([{ inventoryItemId: c }], store.id);
  check("all 12 go out", m5.ok, m5.ok ? undefined : m5.error);
  check("nothing is left in the safe", (await itemOf(c)).jewelry?.remainingQty === 0);
  const m6 = await memoOut([{ inventoryItemId: c }], stylist.id);
  check("the whole lot moves on", m6.ok, m6.ok ? undefined : m6.error);
  if (m5.ok && m6.ok) {
    check(
      "the balance is still 0 — not negative",
      (await itemOf(c)).jewelry?.remainingQty === 0,
      (await itemOf(c)).jewelry?.remainingQty
    );
    const moved = await lineOf(m6.document.id, c);
    check("the new line carries all 12 pieces", moved.quantity === 12, moved.quantity);
    check("priced as 12", Number(moved.totalPrice) === 12000, moved.totalPrice);
    check("the store's line released", (await lineOf(m5.document.id, c)).lineStatus === "RETURNED");
    check("and it is still ON_MEMO", (await itemOf(c)).status === "ON_MEMO");
  }

  console.log("\n[6] a partly-out lot is untouched — that stock is still ours to send");
  const d = await lot(`${PREFIX}-D`, 10);
  const m7 = await memoOut([{ inventoryItemId: d, quantity: 4 }], store.id);
  check("4 of 10 go to the store", m7.ok, m7.ok ? undefined : m7.error);
  check("the lot stays IN_STOCK", (await itemOf(d)).status === "IN_STOCK");
  const m8 = await memoOut([{ inventoryItemId: d, quantity: 3 }], stylist.id);
  check("3 more go to the stylist from the safe", m8.ok, m8.ok ? undefined : m8.error);
  if (m7.ok && m8.ok) {
    check("3 remain in the safe", (await itemOf(d)).jewelry?.remainingQty === 3, (await itemOf(d)).jewelry?.remainingQty);
    check(
      "the store's 4 are NOT released — they never moved",
      (await lineOf(m7.document.id, d)).lineStatus === "ON_MEMO"
    );
    check("the store's memo stays open", (await docOf(m7.document.id)).status === "OPEN");
  }

  console.log("\n[7] a parcel wholly out moves on its memo'd slice");
  const e = await parcel(`${PREFIX}-E`, 5);
  const m9 = await memoOut([{ inventoryItemId: e }], store.id);
  check("the whole 5 ct go out", m9.ok, m9.ok ? undefined : m9.error);
  check("the parcel is ON_MEMO", (await itemOf(e)).status === "ON_MEMO");
  const m10 = await memoOut([{ inventoryItemId: e }], stylist.id);
  check("the slice moves on", m10.ok, m10.ok ? undefined : m10.error);
  if (m9.ok && m10.ok) {
    check("the balance is still 0", Number((await itemOf(e)).stone?.remainingCt) === 0);
    const moved = await lineOf(m10.document.id, e);
    check("the new line carries 5 ct", Number(moved.caratWeight) === 5, moved.caratWeight);
    check("the store's line released", (await lineOf(m9.document.id, e)).lineStatus === "RETURNED");
  }

  console.log("\n[8] two open memos on one lot refuse to be guessed between");
  const f = await lot(`${PREFIX}-F`, 8);
  const m11 = await memoOut([{ inventoryItemId: f, quantity: 5 }], store.id);
  const m12 = await memoOut([{ inventoryItemId: f, quantity: 3 }], stylist.id);
  check("5 out to one, 3 to the other", m11.ok && m12.ok);
  check("which empties the lot", (await itemOf(f)).status === "ON_MEMO");
  const m13 = await memoOut([{ inventoryItemId: f }], third.id);
  check("a third memo refuses rather than pick one", !m13.ok, m13.ok ? "accepted" : m13.error);
  check(
    "and says a return is needed first",
    !m13.ok && m13.error.includes("more than one open memo"),
    m13.ok ? undefined : m13.error
  );

  console.log("\n[9] a return after a transfer still works on the memo that holds it");
  const g = await ring(`${PREFIX}-G`);
  const m14 = await memoOut([{ inventoryItemId: g }], store.id);
  const m15 = await memoOut([{ inventoryItemId: g }], stylist.id);
  check("moved to the stylist", m14.ok && m15.ok);
  if (m15.ok) {
    const ret = await recordMemoReturn(m15.document.id, { inventoryItemIds: [g] } as never, user.id);
    check("the stylist can return it", ret.ok, ret.ok ? undefined : ret.error);
    check("and it lands back in stock", (await itemOf(g)).status === "IN_STOCK");
  }

  const clientIds = [store.id, stylist.id, third.id];
  const docIds = (
    await prisma.document.findMany({ where: { clientId: { in: clientIds } }, select: { id: true } })
  ).map((d) => d.id);
  await prisma.documentLineItem.deleteMany({ where: { documentId: { in: docIds } } });
  await prisma.itemStatusHistory.deleteMany({ where: { inventoryItemId: { in: created } } });
  await prisma.document.deleteMany({ where: { id: { in: docIds } } });
  await prisma.inventoryItem.deleteMany({ where: { id: { in: created } } });
  await prisma.company.deleteMany({ where: { id: { in: clientIds } } }).catch(() => undefined);
  await prisma.vendor.delete({ where: { id: vendor.id } }).catch(() => undefined);
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
