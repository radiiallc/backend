/**
 * Backfill for stock imported before the importer copied the vendor SKU.
 *
 * A RADIIA SKU is meant to be the vendor/brand's own number unless someone
 * deliberately assigns a different one — that is what a client sees on a memo.
 * Stock received before that rule went in got an internal RAD-#### instead, so
 * Reinstein Ross pieces print as RAD-01042 rather than the style number the
 * designer (and the client) knows them by.
 *
 * Rewrites `sku` to `vendorSku` for items whose SKU is still auto-minted. An
 * assigned SKU is never touched — that is the deliberate override. Neither is
 * a copy that would collide, since `sku` is unique: two vendors may share a
 * style number, and one sheet may list a style twice.
 *
 * Documents join their lines back to the live item, so a memo already sent
 * re-prints with the new SKU. Nothing else keys off `sku` — portal carts and
 * requests snapshot the feed's own SKU, not this one.
 *
 * Dry-run unless --yes is passed. Optional name scopes it to one brand or
 * vendor, which is the safe way to try it before the whole table.
 *
 *   npm run sku:vendor:prod
 *   npm run sku:vendor:prod -- "Reinstein Ross"
 *   npm run sku:vendor:prod -- "Reinstein Ross" --yes
 */
import { prisma, Prisma } from "@/db";
import { MINTED_SKU } from "@/modules/ims/inventory.service";

type Plan = { id: string; from: string; to: string; label: string };

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const confirmed = argv.includes("--yes");
  const name = argv
    .filter((a) => !a.startsWith("--"))
    .join(" ")
    .trim();

  let where: Prisma.InventoryItemWhereInput = {};
  if (name) {
    const [brand, vendor] = await Promise.all([
      prisma.company.findFirst({
        where: { name: { equals: name, mode: "insensitive" } },
        select: { id: true, name: true }
      }),
      prisma.vendor.findFirst({
        where: { name: { equals: name, mode: "insensitive" } },
        select: { id: true, name: true }
      })
    ]);
    if (!brand && !vendor) {
      console.error(`No client/company or vendor named "${name}".`);
      process.exit(1);
    }
    where = brand ? { brandOwnerId: brand.id } : { vendorId: vendor!.id };
    console.log(`Scoped to ${brand ? "brand owner" : "vendor"} "${(brand ?? vendor)!.name}"\n`);
  } else {
    console.log("Scoped to ALL inventory\n");
  }

  const items = await prisma.inventoryItem.findMany({
    where,
    select: { id: true, sku: true, vendorSku: true, itemName: true },
    orderBy: { sku: "asc" }
  });

  // Every SKU on the books, not just the ones in scope — the uniqueness this
  // has to respect is table-wide.
  const allSkus = new Set(
    (await prisma.inventoryItem.findMany({ select: { sku: true } })).map((r) => r.sku)
  );

  const plans: Plan[] = [];
  const assigned: string[] = [];
  const noVendorSku: string[] = [];
  const collides: Array<{ sku: string; wanted: string; why: string }> = [];

  // Two in-scope items sharing a vendor SKU cannot both take it, and picking a
  // winner arbitrarily would be a guess about which piece the number names.
  const shared = new Set<string>();
  const seen = new Set<string>();
  for (const it of items) {
    const v = (it.vendorSku ?? "").trim();
    if (!v || !MINTED_SKU.test(it.sku)) continue;
    if (seen.has(v)) shared.add(v);
    seen.add(v);
  }

  for (const it of items) {
    const wanted = (it.vendorSku ?? "").trim();
    const label = it.itemName || "(unnamed)";
    if (!MINTED_SKU.test(it.sku)) {
      assigned.push(it.sku);
      continue;
    }
    if (!wanted) {
      noVendorSku.push(it.sku);
      continue;
    }
    if (shared.has(wanted)) {
      collides.push({ sku: it.sku, wanted, why: "another item in scope has the same vendor SKU" });
      continue;
    }
    if (allSkus.has(wanted)) {
      collides.push({ sku: it.sku, wanted, why: "already the RADIIA SKU of another item" });
      continue;
    }
    plans.push({ id: it.id, from: it.sku, to: wanted, label });
  }

  for (const p of plans) {
    console.log(`  ${p.from.padEnd(12)} -> ${p.to.padEnd(18)} ${p.label}`);
  }

  console.log(
    `\n  ${plans.length} to rewrite · ${assigned.length} already have an assigned SKU · ` +
      `${noVendorSku.length} have no vendor SKU to copy · ${collides.length} would collide`
  );
  for (const c of collides) {
    console.log(`  ⚠ ${c.sku} keeps its SKU — "${c.wanted}" ${c.why}`);
  }

  if (plans.length === 0) {
    console.log("\nNothing to do.");
    return;
  }
  if (!confirmed) {
    console.log("\nDry run — nothing written. Re-run with --yes to apply.");
    return;
  }

  // Each row takes a different value, so this is the one shape that still moves
  // in a single statement: hand the whole plan over as JSON and let the
  // database join it. A loop of updates would be one remote round trip per
  // item, which over a pooled connection is minutes of silence.
  const payload = JSON.stringify(plans.map((p) => ({ id: p.id, sku: p.to })));
  const updated = await prisma.$executeRaw`
    UPDATE "InventoryItem" i
       SET "sku" = v."sku", "updatedAt" = now()
      FROM jsonb_to_recordset(${payload}::jsonb) AS v("id" text, "sku" text)
     WHERE i."id" = v."id"
  `;
  console.log(`\nUpdated ${updated} row(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
