// Manual Skylab API tool (WORKPLAN §1.6). Run on the DEV database only.
//
//   npm run skylab:fetch       # pull the API, print status/shape distributions +
//                              # a sample normalized row (verify the mapping +
//                              # discover the real lot_status / shape vocabulary)
//   npm run skylab:reconcile   # compare the API against the DB Skylab rows,
//                              # read-only (the parallel-run validation report)
//
// Neither command writes to the live table. Use these during the ~2-week parallel
// run to confirm the API data before flipping SKYLAB_SOURCE=api.

import { prisma } from "@/db";
import { fetchSkylabStock } from "@/integrations/inventory/skylab-api";
import {
  isSkylabAvailable,
  mapSkylabStone,
  parseSkylabStock,
  skylabLotStatus
} from "@/integrations/inventory/skylab-adapter";
import { reconcileSkylab } from "@/integrations/inventory/skylab-reconcile";

function sortedCounts(entries: Iterable<[string, number]>): [string, number][] {
  return Array.from(entries).sort((a, b) => b[1] - a[1]);
}

async function runFetch(): Promise<void> {
  const { success, count, stones } = await fetchSkylabStock();

  const statusDist = new Map<string, number>();
  const shapeDist = new Map<string, number>();
  for (const stone of stones) {
    const status = skylabLotStatus(stone) || "(blank)";
    statusDist.set(status, (statusDist.get(status) ?? 0) + 1);
    if (isSkylabAvailable(stone)) {
      const shape = (stone.shape ? String(stone.shape).trim() : "") || "(blank)";
      shapeDist.set(shape, (shapeDist.get(shape) ?? 0) + 1);
    }
  }

  const parsed = parseSkylabStock(stones);

  console.log("=== Skylab API fetch ===");
  console.log(`success=${success}  reported count=${count}  received=${stones.length}`);
  console.log(`available (by SKYLAB_AVAILABLE_STATUSES)=${stones.filter(isSkylabAvailable).length}`);
  console.log(`ingestable rows=${parsed.rows.length}`);
  console.log("");

  console.log("lot_status distribution (ALL rows — confirm which mean available):");
  for (const [status, n] of sortedCounts(statusDist)) console.log(`  ${status.padEnd(16)} ${n}`);
  console.log("");

  console.log("shape distribution (available rows — confirm every shape maps):");
  for (const [shape, n] of sortedCounts(shapeDist)) console.log(`  ${shape.padEnd(16)} ${n}`);
  console.log("");

  console.log("reject tally:");
  if (parsed.rejected.length === 0) console.log("  (none)");
  for (const r of parsed.rejected) console.log(`  ${r.reason.padEnd(20)} ${r.count}`);
  console.log("");

  const firstAvailable = stones.find(isSkylabAvailable);
  if (firstAvailable) {
    const mapped = mapSkylabStone(firstAvailable, 0);
    console.log("sample RAW stone:");
    console.log(JSON.stringify(firstAvailable, null, 2));
    console.log("sample NORMALIZED (ParsedDiamond):");
    console.log(JSON.stringify(mapped.ok ? mapped.row : mapped, null, 2));
  }
}

async function runReconcile(): Promise<void> {
  const report = await reconcileSkylab();
  console.log("=== Skylab API ↔ DB reconcile ===");
  console.log(JSON.stringify(report, null, 2));
  console.log("");
  console.log("Summary:");
  console.log(`  API total / available / usable: ${report.api.total} / ${report.api.available} / ${report.api.usable}`);
  console.log(`  DB Skylab total / available:    ${report.db.skylabTotal} / ${report.db.skylabAvailable}`);
  console.log(`  matched by cert:                ${report.reconcile.matchedByCert}`);
  console.log(`  LEAKING (DB available, API not):${report.reconcile.leakingCount}  <- the 638-025ADA class`);
  console.log(`  new in API (not in DB):         ${report.reconcile.newInApiCount}`);
  console.log(`  price-per-ct diffs:             ${report.reconcile.priceDiffCount}`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  switch (command) {
    case "fetch":
      await runFetch();
      break;
    case "reconcile":
      await runReconcile();
      break;
    default:
      console.error("Usage: tsx scripts/skylab-api.ts <fetch|reconcile>");
      process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
