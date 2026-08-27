/**
 * Can one Memo Out carry 300+ lines?
 *
 * Jennifer memos Reinstein Ross's whole open stock out to a store, and against a
 * local database that always looked fine — 320 lines in ~1.7s. It still failed
 * in prod with a bare "Internal error", because wall clock on localhost is the
 * wrong measurement: what costs money on a remote database is the number of
 * ROUND TRIPS, and each one there is ~50-100x slower than it is here.
 *
 * So this counts statements as well as milliseconds, and projects the wall clock
 * those statements would cost at realistic remote latencies. A per-item loop of
 * 374 lines is ~1,500 round trips, which is over the transaction budget long
 * before it is over any local timer.
 *
 *   npm run perf:outbound                 # 374 lines, the real file's size
 *   npm run perf:outbound -- 800          # push it further
 *   npm run perf:outbound -- --budget     # check the timeout refusal is clean
 */
import { PrismaClient } from "@prisma/client";

const args = process.argv.slice(2);
const BUDGET_CHECK = args.includes("--budget");
const LINES = Number(args.find((a) => !a.startsWith("--")) ?? 374);
const INVOICE_SLICE = 50;
const PREFIX = "SMOKE-BULK";

// A transaction that cannot finish is the failure being fixed, so the refusal it
// produces is worth testing too. The service reads its budget once at import, so
// this has to be set before the dynamic import below.
if (BUDGET_CHECK) process.env.IMS_OUTBOUND_TX_TIMEOUT_MS = "1";

/**
 * Count round trips by standing in for the shared client. `@/db` caches it on
 * globalThis outside production, so seeding that slot first means the service
 * under test talks through this one without knowing.
 */
const counting = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
(globalThis as unknown as { prisma?: PrismaClient }).prisma = counting;
let queries = 0;
counting.$on("query", () => {
  queries += 1;
});
function countingFrom<T>(run: () => Promise<T>): Promise<{ result: T; queries: number; ms: number }> {
  const from = queries;
  const started = Date.now();
  return run().then((result) => ({ result, queries: queries - from, ms: Date.now() - started }));
}

/** What those round trips cost once the database is not on this machine. */
function project(count: number): string {
  return [10, 25, 50, 100]
    .map((rtt) => `${rtt}ms→${(((count * rtt) / 1000)).toFixed(1)}s`)
    .join("  ");
}

async function main(): Promise<void> {
  const { prisma } = await import("@/db");
  const { createOutboundDocument, recordMemoReturn } = await import("@/modules/ims/documents.service");
  const { createInventoryItem } = await import("@/modules/ims/inventory.service");

  const user = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
  const brand =
    (await prisma.company.findFirst({ where: { name: `${PREFIX} Brand` } })) ??
    (await prisma.company.create({ data: { name: `${PREFIX} Brand`, clientStatus: "ACTIVE" } }));
  const store =
    (await prisma.company.findFirst({ where: { name: `${PREFIX} Store` } })) ??
    (await prisma.company.create({ data: { name: `${PREFIX} Store`, clientStatus: "ACTIVE" } }));

  console.log(`seeding ${LINES} jewelry items...`);
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

  console.log(`\ncreating ONE Memo Out with ${ids.length} lines...`);
  const memo = await countingFrom(() =>
    createOutboundDocument(
      { type: "MEMO_OUT", clientId: store.id, inventoryItemIds: ids } as never,
      user.id
    )
  );
  console.log(`  ${memo.result.ok ? "OK" : "FAILED"} in ${memo.ms} ms · ${memo.queries} round trips`);
  if (!memo.result.ok) console.log(`  error: ${memo.result.error}`);

  if (BUDGET_CHECK) {
    // Nothing may survive a transaction that ran out of budget, and the caller
    // must get a sentence rather than a 500.
    const clean =
      !memo.result.ok &&
      /took too long to save and was rolled back/.test(memo.result.error) &&
      (await prisma.document.count({ where: { clientId: store.id } })) === 0;
    console.log(`\n  ${clean ? "ok  " : "FAIL"} an over-budget save refuses cleanly and writes nothing`);
    await cleanup(prisma, ids, [store.id, brand.id]);
    process.exitCode = clean ? 0 : 1;
    return;
  }

  if (memo.result.ok) {
    const memoId = memo.result.document.id;
    const lineCount = await prisma.documentLineItem.count({
      where: { documentId: memo.result.document.id }
    });
    const onMemo = await prisma.inventoryItem.count({
      where: { id: { in: ids }, status: "ON_MEMO" }
    });
    console.log(`  lines written: ${lineCount}/${ids.length}`);
    console.log(`  items now ON_MEMO: ${onMemo}/${ids.length}`);
    console.log(`  projected wall clock remote: ${project(memo.queries)}`);

    console.log(`\ninvoicing ${INVOICE_SLICE} of them off that memo...`);
    const inv = await countingFrom(() =>
      createOutboundDocument(
        { type: "INVOICE", clientId: store.id, inventoryItemIds: ids.slice(0, INVOICE_SLICE) } as never,
        user.id
      )
    );
    console.log(`  ${inv.result.ok ? "OK" : "FAILED"} in ${inv.ms} ms · ${inv.queries} round trips`);
    if (!inv.result.ok) console.log(`  error: ${inv.result.error}`);
    console.log(`  projected wall clock remote: ${project(inv.queries)}`);

    const doc = await prisma.document.findUniqueOrThrow({ where: { id: memo.result.document.id } });
    const sold = await prisma.documentLineItem.count({
      where: { documentId: memo.result.document.id, lineStatus: "SOLD" }
    });
    const stillOut = await prisma.documentLineItem.count({
      where: { documentId: memo.result.document.id, lineStatus: "ON_MEMO" }
    });
    console.log(`  memo lines SOLD: ${sold} · still ON_MEMO: ${stillOut}`);
    console.log(`  memo status: ${doc.status} (expected OPEN — the rest are still out)`);

    console.log(`\nreturning everything still out on that memo...`);
    const ret = await countingFrom(() => recordMemoReturn(memoId, {} as never, user.id));
    console.log(`  ${ret.result.ok ? "OK" : "FAILED"} in ${ret.ms} ms · ${ret.queries} round trips`);
    if (!ret.result.ok) console.log(`  error: ${ret.result.error}`);
    console.log(`  projected wall clock remote: ${project(ret.queries)}`);
    const backInStock = await prisma.inventoryItem.count({
      where: { id: { in: ids.slice(INVOICE_SLICE) }, status: "IN_STOCK" }
    });
    const closed = await prisma.document.findUniqueOrThrow({ where: { id: memoId } });
    console.log(`  back IN_STOCK: ${backInStock}/${ids.length - INVOICE_SLICE} · memo now ${closed.status}`);

    console.log(`\nreading the memo back (what DocDetail does)...`);
    const read = await countingFrom(() =>
      prisma.document.findUnique({
        where: { id: memo.result.ok ? memo.result.document.id : "" },
        include: {
          lineItems: { include: { inventoryItem: { include: { jewelry: true, stone: true } } } },
          client: true
        }
      })
    );
    console.log(`  read in ${read.ms} ms · ${read.queries} round trips`);
  }

  const docCount = await cleanup(prisma, ids, [store.id, brand.id]);
  console.log(`\ncleaned up ${ids.length} item(s), ${docCount} doc(s)`);

  console.log(`\n${"=".repeat(60)}`);
  console.log(
    `${LINES}-line Memo Out: ${memo.result.ok ? `${memo.ms} ms · ${memo.queries} round trips` : "FAILED"}`
  );
  console.log(`per-line round trips: ${(memo.queries / LINES).toFixed(3)} (a per-item loop is ~4)`);
}

async function cleanup(
  prisma: import("@prisma/client").PrismaClient,
  ids: string[],
  companyIds: string[]
): Promise<number> {
  const docIds = (
    await prisma.document.findMany({ where: { clientId: { in: companyIds } }, select: { id: true } })
  ).map((d) => d.id);
  await prisma.documentLineItem.deleteMany({ where: { documentId: { in: docIds } } });
  await prisma.itemStatusHistory.deleteMany({ where: { inventoryItemId: { in: ids } } });
  await prisma.document.deleteMany({ where: { id: { in: docIds } } });
  await prisma.inventoryItem.deleteMany({ where: { id: { in: ids } } });
  await prisma.company.deleteMany({ where: { id: { in: companyIds } } }).catch(() => undefined);
  return docIds.length;
}

main()
  .catch((e) => {
    console.error("PERF RUN CRASHED:", e);
    process.exitCode = 1;
  })
  .finally(() => counting.$disconnect());
