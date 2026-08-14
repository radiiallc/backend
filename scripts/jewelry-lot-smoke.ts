import { prisma } from "@/db";
import {
  createOutboundDocument,
  recordMemoReturn,
  voidDocument
} from "@/modules/ims/documents.service";
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

const PREFIX = "SMOKE-JLOT";

async function balance(id: string): Promise<{ qty: number | null; status: string }> {
  const it = await prisma.inventoryItem.findUniqueOrThrow({
    where: { id },
    include: { jewelry: true }
  });
  return { qty: it.jewelry?.remainingQty ?? null, status: it.status };
}

async function lineOf(docId: string, itemId: string) {
  return prisma.documentLineItem.findFirstOrThrow({
    where: { documentId: docId, inventoryItemId: itemId }
  });
}

async function main(): Promise<void> {
  const user = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
  const vendor = await prisma.vendor.upsert({
    where: { name: `${PREFIX} Vendor` },
    create: { name: `${PREFIX} Vendor` },
    update: {}
  });
  const client =
    (await prisma.company.findFirst({ where: { name: `${PREFIX} Client` } })) ??
    (await prisma.company.create({ data: { name: `${PREFIX} Client`, clientStatus: "ACTIVE" } }));
  const client2 =
    (await prisma.company.findFirst({ where: { name: `${PREFIX} Client 2` } })) ??
    (await prisma.company.create({ data: { name: `${PREFIX} Client 2`, clientStatus: "ACTIVE" } }));

  const created: string[] = [];
  async function hoops(sku: string, quantity: number): Promise<string> {
    const res = await createInventoryItem(
      {
        itemType: "JEWELRY",
        sku,
        vendorId: vendor.id,
        jewelry: {
          jewelryItemType: "Earrings",
          metal: "20k Peach",
          quantity,
          productionCost: 695,
          wholesalePrice: 1000,
          retailPrice: 1550
        }
      } as never
    );
    if (!res.ok) throw new Error(`could not create ${sku}: ${res.error}`);
    created.push(res.item.id);
    return res.item.id;
  }

  const memoOut = (lines: unknown[], clientId: string) =>
    createOutboundDocument({ type: "MEMO_OUT", clientId, lines } as never, user.id);
  const invoice = (lines: unknown[], clientId: string) =>
    createOutboundDocument({ type: "INVOICE", clientId, lines } as never, user.id);

  console.log("\n[1] opening balance");
  const a = await hoops(`${PREFIX}-A`, 16);
  check("a new jewelry line opens at a full balance", (await balance(a)).qty === 16, await balance(a));
  const single = await hoops(`${PREFIX}-SINGLE`, 1);
  check("a one-off piece opens at 1", (await balance(single)).qty === 1);

  console.log("\n[2] partial memo out");
  const m1 = await memoOut([{ inventoryItemId: a, quantity: 3 }], client.id);
  check("3 of 16 can go out on a memo", m1.ok, m1.ok ? undefined : m1.error);
  const b1 = await balance(a);
  check("balance drops to 13", b1.qty === 13, b1);
  check("a part-sent line STAYS IN_STOCK", b1.status === "IN_STOCK", b1);
  if (m1.ok) {
    const l = await lineOf(m1.document.id, a);
    check("the line records 3 pieces", l.quantity === 3, l.quantity);
    check("priced 3 x 1000 = 3000, not the whole line", Number(l.totalPrice) === 3000, l.totalPrice);
  }

  console.log("\n[3] over-send is refused");
  const tooMany = await memoOut([{ inventoryItemId: a, quantity: 14 }], client.id);
  check("cannot send more than remains", !tooMany.ok, tooMany.ok ? "allowed" : tooMany.error);
  check(
    "and says how many are left",
    !tooMany.ok && tooMany.error.includes("only 13 piece(s) remaining"),
    tooMany.ok ? undefined : tooMany.error
  );
  check("a refused send moves nothing", (await balance(a)).qty === 13);

  console.log("\n[4] return restores the pieces");
  if (m1.ok) {
    const ret = await recordMemoReturn(m1.document.id, { inventoryItemIds: [a] } as never, user.id);
    check("the memo can be returned", ret.ok, ret.ok ? undefined : ret.error);
    check("balance back to 16", (await balance(a)).qty === 16, await balance(a));
    const noise = await prisma.itemStatusHistory.count({
      where: { inventoryItemId: a, previousStatus: "IN_STOCK", newStatus: "IN_STOCK" }
    });
    check("no IN_STOCK -> IN_STOCK noise in the audit trail", noise === 0, noise);
  }

  console.log("\n[5] invoice SETTLES the memo'd pieces — it must not draw twice");
  const m2 = await memoOut([{ inventoryItemId: a, quantity: 4 }], client.id);
  check("4 go out on a second memo", m2.ok, m2.ok ? undefined : m2.error);
  check("balance 12", (await balance(a)).qty === 12, await balance(a));
  const inv1 = await invoice([{ inventoryItemId: a, quantity: 4 }], client.id);
  check("the client buys the 4 they hold", inv1.ok, inv1.ok ? undefined : inv1.error);
  check("SETTLE draws nothing more — still 12", (await balance(a)).qty === 12, await balance(a));
  if (m2.ok) {
    const ml = await lineOf(m2.document.id, a);
    check("the memo line is resolved to SOLD", ml.lineStatus === "SOLD", ml.lineStatus);
    const memoDoc = await prisma.document.findUniqueOrThrow({ where: { id: m2.document.id } });
    check("the memo auto-closes", memoDoc.status === "CLOSED", memoDoc.status);
  }
  if (inv1.ok) {
    const il = await lineOf(inv1.document.id, a);
    check("the invoice prices 4 x 1000 = 4000", Number(il.totalPrice) === 4000, il.totalPrice);
  }

  console.log("\n[6] a DIFFERENT quantity draws fresh off what is left");
  const m3 = await memoOut([{ inventoryItemId: a, quantity: 3 }], client.id);
  check("3 out on memo", m3.ok, m3.ok ? undefined : m3.error);
  check("balance 9", (await balance(a)).qty === 9, await balance(a));
  const inv2 = await invoice([{ inventoryItemId: a, quantity: 2 }], client.id);
  check("buying 2 while holding 3 is allowed", inv2.ok, inv2.ok ? undefined : inv2.error);
  check("those 2 come off the shelf — balance 7", (await balance(a)).qty === 7, await balance(a));
  if (m3.ok) {
    const ml = await lineOf(m3.document.id, a);
    check("the 3 on memo stay ON_MEMO", ml.lineStatus === "ON_MEMO", ml.lineStatus);
    const memoDoc = await prisma.document.findUniqueOrThrow({ where: { id: m3.document.id } });
    check("and that memo stays OPEN", memoDoc.status === "OPEN", memoDoc.status);
  }

  console.log("\n[7] one client's settlement never touches another's");
  const mOther = await memoOut([{ inventoryItemId: a, quantity: 2 }], client2.id);
  check("client 2 memos 2 of the same line", mOther.ok, mOther.ok ? undefined : mOther.error);
  check("balance 5", (await balance(a)).qty === 5, await balance(a));
  const inv3 = await invoice([{ inventoryItemId: a, quantity: 3 }], client.id);
  check("client 1 settles their 3", inv3.ok, inv3.ok ? undefined : inv3.error);
  if (mOther.ok) {
    const ml = await lineOf(mOther.document.id, a);
    check("client 2's line is NOT resolved", ml.lineStatus === "ON_MEMO", ml.lineStatus);
    const d = await prisma.document.findUniqueOrThrow({ where: { id: mOther.document.id } });
    check("client 2's memo stays OPEN", d.status === "OPEN", d.status);
  }
  check("settling moved no stock — still 5", (await balance(a)).qty === 5, await balance(a));
  check("the line is still IN_STOCK with 5 left", (await balance(a)).status === "IN_STOCK");

  console.log("\n[8] the last piece flips the line");
  const b = await hoops(`${PREFIX}-B`, 2);
  const mb = await memoOut([{ inventoryItemId: b, quantity: 1 }], client.id);
  check("1 of 2 out", mb.ok && (await balance(b)).qty === 1, await balance(b));
  check("still IN_STOCK at 1", (await balance(b)).status === "IN_STOCK");
  const mb2 = await memoOut([{ inventoryItemId: b, quantity: 1 }], client.id);
  check("the last one goes out", mb2.ok, mb2.ok ? undefined : mb2.error);
  const bb = await balance(b);
  check("balance 0", bb.qty === 0, bb);
  check("NOW the line flips ON_MEMO", bb.status === "ON_MEMO", bb);
  const empty = await memoOut([{ inventoryItemId: b, quantity: 1 }], client.id);
  check("an emptied line cannot send more", !empty.ok, empty.ok ? "allowed" : empty.error);

  console.log("\n[9] whole-line send still works (no quantity given)");
  const c = await hoops(`${PREFIX}-C`, 5);
  const mc = await memoOut([{ inventoryItemId: c }], client.id);
  check("sending with no quantity takes the whole line", mc.ok, mc.ok ? undefined : mc.error);
  const cb = await balance(c);
  check("balance 0 and ON_MEMO", cb.qty === 0 && cb.status === "ON_MEMO", cb);
  if (mc.ok) {
    const l = await lineOf(mc.document.id, c);
    check("priced 5 x 1000 = 5000", Number(l.totalPrice) === 5000, l.totalPrice);
  }

  console.log("\n[10] void reverses a partial send");
  const d = await hoops(`${PREFIX}-D`, 10);
  const md = await memoOut([{ inventoryItemId: d, quantity: 4 }], client.id);
  check("4 out", md.ok && (await balance(d)).qty === 6, await balance(d));
  if (md.ok) {
    const v = await voidDocument(md.document.id, user.id);
    check("the memo can be voided", v.ok, v.ok ? undefined : v.error);
    check("the 4 come back — balance 10", (await balance(d)).qty === 10, await balance(d));
    check("still IN_STOCK", (await balance(d)).status === "IN_STOCK");
  }

  console.log("\n[11] a single piece behaves exactly as before");
  const inv4 = await invoice([{ inventoryItemId: single }], client.id);
  check("a one-off piece invoices whole", inv4.ok, inv4.ok ? undefined : inv4.error);
  const sb = await balance(single);
  check("balance 0 and SOLD", sb.qty === 0 && sb.status === "SOLD", sb);
  if (inv4.ok) {
    const l = await lineOf(inv4.document.id, single);
    check("priced once, not multiplied", Number(l.totalPrice) === 1000, l.totalPrice);
  }

  const clientIds = [client.id, client2.id];
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
