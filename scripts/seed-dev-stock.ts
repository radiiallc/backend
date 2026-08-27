/**
 * Put a real inventory export into the LOCAL dev database so the admin can be
 * clicked through against it.
 *
 * An export from prod names prod SKUs, and dev has never heard of them — so an
 * outbound upload of that file against dev correctly matches nothing. That is
 * the importer working, not failing, but it makes the UI impossible to try.
 * This mints the same SKUs locally so the click-through is the real thing.
 *
 *   npm run seed:devstock -- "info/8-26 shared files/radiia-inventory-2026-08-26 (1).csv"
 *   npm run seed:devstock -- --clean          # remove whatever this seeded
 *
 * Dev only, and it checks: a DATABASE_URL that is not local aborts.
 */
import { readFileSync } from "node:fs";
import { prisma } from "@/db";

const BRAND = "Reinstein Ross";
/** Seeded rows are tagged in notes so --clean can find exactly them and nothing else. */
const TAG = "seeded-by-seed-dev-stock";

function assertLocal(): void {
  const url = process.env.DATABASE_URL ?? "";
  if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) {
    console.error("Refusing to run: DATABASE_URL is not a local database.");
    console.error("This script only ever seeds dev. Use `npm run seed:devstock`, which loads .env.dev.");
    process.exit(1);
  }
}

/** Minimal CSV row splitter — enough for a quoted description field. */
function splitRow(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      out.push(cell);
      cell = "";
    } else cell += ch;
  }
  out.push(cell);
  return out.map((c) => c.trim());
}

async function clean(): Promise<void> {
  const items = await prisma.inventoryItem.findMany({ where: { notes: TAG }, select: { id: true } });
  const ids = items.map((i) => i.id);
  if (!ids.length) {
    console.log("Nothing to clean — no seeded items found.");
    return;
  }
  const lines = await prisma.documentLineItem.findMany({
    where: { inventoryItemId: { in: ids } },
    select: { documentId: true }
  });
  const docIds = [...new Set(lines.map((l) => l.documentId))];
  await prisma.documentLineItem.deleteMany({ where: { documentId: { in: docIds } } });
  await prisma.document.deleteMany({ where: { id: { in: docIds } } });
  await prisma.itemStatusHistory.deleteMany({ where: { inventoryItemId: { in: ids } } });
  await prisma.inventoryItem.deleteMany({ where: { id: { in: ids } } });
  console.log(`Removed ${ids.length} seeded item(s) and ${docIds.length} document(s) built on them.`);
}

async function main(): Promise<void> {
  assertLocal();
  const args = process.argv.slice(2);
  if (args.includes("--clean")) {
    await clean();
    return;
  }

  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error('Usage: npm run seed:devstock -- "path/to/inventory-export.csv"   (or --clean)');
    process.exit(1);
  }

  const rows = readFileSync(file, "utf8")
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim());
  const header = splitRow(rows[0]).map((h) => h.toLowerCase());
  const at = (name: string) => header.indexOf(name);
  const iSku = at("sku");
  const iItem = at("item");
  const iWholesale = at("wholesale");
  if (iSku < 0) {
    console.error(`No SKU column in ${file}. Headers found: ${header.join(", ")}`);
    process.exit(1);
  }

  const brand =
    (await prisma.company.findFirst({ where: { name: BRAND } })) ??
    (await prisma.company.create({ data: { name: BRAND, clientStatus: "ACTIVE" } }));

  const parsed = rows
    .slice(1)
    .map(splitRow)
    .map((c) => ({
      sku: c[iSku],
      name: iItem >= 0 ? c[iItem] : "",
      wholesale: Number(String(iWholesale >= 0 ? c[iWholesale] : "").replace(/[^0-9.]/g, "")) || 1495
    }))
    .filter((r) => /^RAD-/i.test(r.sku));

  const existing = new Set(
    (
      await prisma.inventoryItem.findMany({
        where: { sku: { in: parsed.map((r) => r.sku) } },
        select: { sku: true }
      })
    ).map((r) => r.sku)
  );
  const fresh = parsed.filter((r) => !existing.has(r.sku));
  if (!fresh.length) {
    console.log(`All ${parsed.length} SKU(s) already exist in dev — nothing to do.`);
    return;
  }

  const started = Date.now();
  // A batch $transaction, not an interactive one — no timeout to raise, and the
  // whole seed is one round trip.
  await prisma.$transaction(
    fresh.map((r) =>
      prisma.inventoryItem.create({
        data: {
          sku: r.sku,
          itemName: r.name || r.sku,
          itemType: "JEWELRY",
          status: "IN_STOCK",
          brandOwnerId: brand.id,
          notes: TAG,
          jewelry: {
            create: {
              jewelryItemType: "Ring",
              metal: "20K Peach Gold",
              quantity: 1,
              remainingQty: 1,
              // The export carries a wholesale price but no cost; mirroring the
              // two is what Jennifer asked for on 08-26 anyway.
              productionCost: r.wholesale,
              wholesalePrice: r.wholesale
            }
          }
        }
      })
    )
  );

  console.log(
    `Seeded ${fresh.length} piece(s) under "${BRAND}" in ${Date.now() - started}ms` +
      (existing.size ? ` (${existing.size} already existed)` : "")
  );
  console.log("Undo with: npm run seed:devstock -- --clean");
}

main()
  .catch((e) => {
    console.error("SEED FAILED:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
