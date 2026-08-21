
/**
 * Backfill for stock imported before the importer learned to mirror prices.
 *
 * Where an item has a cost but no wholesale (or the reverse), copy the one it
 * has into the one it lacks. Brands quote a single number and the blank side
 * leaves every Memo Out and Invoice against that stock unpriced.
 *
 * Scoped to a brand owner by name. Dry-run unless --yes is passed. Existing
 * document lines are NOT touched — they hold the price the paperwork was
 * struck with, and rewriting history is not the job here.
 *
 *   npm run mirror:prices:prod -- "Reinstein Ross"
 *   npm run mirror:prices:prod -- "Reinstein Ross" --yes
 */
import { prisma } from "@/db";
import { Prisma } from "@prisma/client";

type Plan = { sku: string; label: string; field: string; from: string; value: Prisma.Decimal };

async function main() {
  const argv = process.argv.slice(2);
  const confirmed = argv.includes("--yes");
  const name = argv.filter((a) => !a.startsWith("--")).join(" ").trim();

  if (!name) {
    console.error('Pass a brand owner name. Example: -- "Reinstein Ross"');
    process.exit(1);
  }

  const brand = await prisma.company.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
    select: { id: true, name: true }
  });
  if (!brand) {
    console.error(`No client/company named "${name}".`);
    process.exit(1);
  }

  const items = await prisma.inventoryItem.findMany({
    where: { brandOwnerId: brand.id },
    select: {
      id: true,
      sku: true,
      itemName: true,
      stone: { select: { costPerCt: true, wholesalePricePerCt: true } },
      jewelry: { select: { productionCost: true, wholesalePrice: true } },
      material: { select: { cost: true, wholesalePrice: true } }
    },
    orderBy: { sku: "asc" }
  });

  console.log(`${brand.name} — ${items.length} item(s) in inventory\n`);

  const plans: Plan[] = [];
  const both: string[] = [];
  const neither: string[] = [];

  for (const it of items) {
    const label = it.itemName || it.sku;
    // Each detail table names the pair differently, so normalise before deciding.
    const pair = it.stone
      ? { cost: it.stone.costPerCt, whl: it.stone.wholesalePricePerCt, table: "stone", costField: "costPerCt", whlField: "wholesalePricePerCt" }
      : it.jewelry
        ? { cost: it.jewelry.productionCost, whl: it.jewelry.wholesalePrice, table: "jewelry", costField: "productionCost", whlField: "wholesalePrice" }
        : it.material
          ? { cost: it.material.cost, whl: it.material.wholesalePrice, table: "material", costField: "cost", whlField: "wholesalePrice" }
          : null;
    if (!pair) continue;

    const hasCost = pair.cost !== null;
    const hasWhl = pair.whl !== null;
    if (hasCost && hasWhl) { both.push(it.sku); continue; }
    if (!hasCost && !hasWhl) { neither.push(it.sku); continue; }

    plans.push(
      hasCost
        ? { sku: it.sku, label, field: `${pair.table}.${pair.whlField}`, from: pair.costField, value: pair.cost! }
        : { sku: it.sku, label, field: `${pair.table}.${pair.costField}`, from: pair.whlField, value: pair.whl! }
    );
  }

  for (const p of plans) {
    console.log(`  ${p.sku.padEnd(12)} ${p.field} := ${p.value.toString()}  (from ${p.from})   ${p.label}`);
  }

  console.log(`\n  ${plans.length} to fill · ${both.length} already have both · ${neither.length} have neither`);
  if (neither.length > 0) {
    console.log(`  ⚠ no price at all, left untouched: ${neither.join(", ")}`);
  }

  if (plans.length === 0) { console.log("\nNothing to do."); return; }
  if (!confirmed) {
    console.log("\nDry run — nothing written. Re-run with --yes to apply.");
    return;
  }

  // Copying one column into another is a single statement per table. Doing it
  // row by row means one network round trip each, which over a remote pooled
  // connection is minutes of silence for work the database does in one pass.
  //
  // Every statement is guarded on IS NULL, so this only ever fills blanks and
  // re-running it is safe — including after a run that was interrupted midway.
  console.log("");
  const counts: Array<[string, number]> = [];

  counts.push(["jewelry wholesale ← cost", await prisma.$executeRaw`
    UPDATE "JewelryDetail" d
       SET "wholesalePrice" = d."productionCost"
      FROM "InventoryItem" i
     WHERE d."inventoryItemId" = i."id"
       AND i."brandOwnerId" = ${brand.id}
       AND d."wholesalePrice" IS NULL
  `]);

  counts.push(["material wholesale ← cost", await prisma.$executeRaw`
    UPDATE "OtherMaterialDetail" d
       SET "wholesalePrice" = d."cost"
      FROM "InventoryItem" i
     WHERE d."inventoryItemId" = i."id"
       AND i."brandOwnerId" = ${brand.id}
       AND d."wholesalePrice" IS NULL
  `]);

  // A stone is the only one where both sides are optional, so it mirrors both ways.
  counts.push(["stone wholesale ← cost", await prisma.$executeRaw`
    UPDATE "StoneDetail" d
       SET "wholesalePricePerCt" = d."costPerCt"
      FROM "InventoryItem" i
     WHERE d."inventoryItemId" = i."id"
       AND i."brandOwnerId" = ${brand.id}
       AND d."wholesalePricePerCt" IS NULL
       AND d."costPerCt" IS NOT NULL
  `]);

  counts.push(["stone cost ← wholesale", await prisma.$executeRaw`
    UPDATE "StoneDetail" d
       SET "costPerCt" = d."wholesalePricePerCt"
      FROM "InventoryItem" i
     WHERE d."inventoryItemId" = i."id"
       AND i."brandOwnerId" = ${brand.id}
       AND d."costPerCt" IS NULL
       AND d."wholesalePricePerCt" IS NOT NULL
  `]);

  let done = 0;
  for (const [label, n] of counts) {
    if (n > 0) console.log(`  ${label}: ${n}`);
    done += n;
  }
  console.log(`\nUpdated ${done} row(s).`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
