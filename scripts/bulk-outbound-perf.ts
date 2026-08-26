/**
 * Can one Memo Out carry 300+ lines?
 *
 * Jennifer is about to memo Reinstein Ross's whole open stock out to a store.
 * createOutboundDocument loops per item with several awaits inside a single
 * transaction, so this measures whether that loop finishes inside the
 * transaction timeout at her scale — and whether invoicing a slice off the
 * resulting memo is still quick.
 */
import { prisma } from "@/db";
import { createOutboundDocument } from "@/modules/ims/documents.service";
import { createInventoryItem } from "@/modules/ims/inventory.service";

const PREFIX = "SMOKE-BULK";
const LINES = Number(process.argv[2] ?? 320);
const INVOICE_SLICE = 50;

function ms(started: number): string {
  return `${(Date.now() - started).toFixed(0)} ms`;
}

async function main(): Promise<void> {
  const user = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
  const brand =
    (await prisma.company.findFirst({ where: { name: `${PREFIX} Brand` } })) ??
    (await prisma.company.create({ data: { name: `${PREFIX} Brand`, clientStatus: "ACTIVE" } }));
  const store =
    (await prisma.company.findFirst({ where: { name: `${PREFIX} Store` } })) ??
    (await prisma.company.create({ data: { name: `${PREFIX} Store`, clientStatus: "ACTIVE" } }));

  console.log(`seeding ${LINES} jewelry items...`);
  const seedStarted = Date.now();
  const ids: string[] = [];
  for (let i = 0; i < LINES; i++) {
    const res = await createInventoryItem({
      itemType: "JEWELRY",
      sku: `${PREFIX}-${String(i).padStart(4, "0")}`,
      brandOwnerId: brand.id,
      jewelry: {
        jewelryItemType: "Earrings",
        metal: "20k Peach",
        // every 6th line is a multi-piece lot, roughly her file's mix
        quantity: i % 6 === 0 ? 16 : 1,
        productionCost: 695,
        wholesalePrice: 1000,
        retailPrice: 1550
      }
    } as never);
    if (!res.ok) throw new Error(`seed ${i} failed: ${res.error}`);
    ids.push(res.item.id);
  }
  console.log(`  seeded in ${ms(seedStarted)}`);

  console.log(`\ncreating ONE Memo Out with ${ids.length} lines...`);
  const memoStarted = Date.now();
  const memo = await createOutboundDocument(
    { type: "MEMO_OUT", clientId: store.id, inventoryItemIds: ids } as never,
    user.id
  );
  const memoMs = Date.now() - memoStarted;
  console.log(`  ${memo.ok ? "OK" : "FAILED"} in ${memoMs} ms`);
  if (!memo.ok) console.log(`  error: ${memo.error}`);

  if (memo.ok) {
    const lineCount = await prisma.documentLineItem.count({
      where: { documentId: memo.document.id }
    });
    const onMemo = await prisma.inventoryItem.count({
      where: { id: { in: ids }, status: "ON_MEMO" }
    });
    console.log(`  lines written: ${lineCount}/${ids.length}`);
    console.log(`  items now ON_MEMO: ${onMemo}/${ids.length}`);

    console.log(`\ninvoicing ${INVOICE_SLICE} of them off that memo...`);
    const invStarted = Date.now();
    const inv = await createOutboundDocument(
      { type: "INVOICE", clientId: store.id, inventoryItemIds: ids.slice(0, INVOICE_SLICE) } as never,
      user.id
    );
    console.log(`  ${inv.ok ? "OK" : "FAILED"} in ${ms(invStarted)}`);
    if (!inv.ok) console.log(`  error: ${inv.error}`);

    const doc = await prisma.document.findUniqueOrThrow({ where: { id: memo.document.id } });
    const sold = await prisma.documentLineItem.count({
      where: { documentId: memo.document.id, lineStatus: "SOLD" }
    });
    const stillOut = await prisma.documentLineItem.count({
      where: { documentId: memo.document.id, lineStatus: "ON_MEMO" }
    });
    console.log(`  memo lines SOLD: ${sold} · still ON_MEMO: ${stillOut}`);
    console.log(`  memo status: ${doc.status} (expected OPEN — the rest are still out)`);

    console.log(`\nreading the memo back (what DocDetail does)...`);
    const readStarted = Date.now();
    await prisma.document.findUnique({
      where: { id: memo.document.id },
      include: {
        lineItems: { include: { inventoryItem: { include: { jewelry: true, stone: true } } } },
        client: true
      }
    });
    console.log(`  read in ${ms(readStarted)}`);
  }

  const docIds = (
    await prisma.document.findMany({
      where: { clientId: { in: [store.id, brand.id] } },
      select: { id: true }
    })
  ).map((d) => d.id);
  await prisma.documentLineItem.deleteMany({ where: { documentId: { in: docIds } } });
  await prisma.itemStatusHistory.deleteMany({ where: { inventoryItemId: { in: ids } } });
  await prisma.document.deleteMany({ where: { id: { in: docIds } } });
  await prisma.inventoryItem.deleteMany({ where: { id: { in: ids } } });
  await prisma.company.deleteMany({ where: { id: { in: [store.id, brand.id] } } }).catch(() => undefined);
  console.log(`\ncleaned up ${ids.length} item(s), ${docIds.length} doc(s)`);

  console.log(`\n${"=".repeat(52)}`);
  console.log(`${LINES}-line Memo Out: ${memo.ok ? `${memoMs} ms` : "FAILED"}`);
}

main()
  .catch((e) => {
    console.error("PERF RUN CRASHED:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
