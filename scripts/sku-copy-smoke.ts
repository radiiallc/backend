/**
 * A RADIIA SKU is the vendor/brand's own number unless someone assigned one.
 *
 * That rule is what a client sees on a memo, so the cases worth pinning are the
 * ones where the copy can't be taken literally: the number is already on the
 * books, the same upload lists it twice, or there is no vendor SKU at all.
 * Every one of those has to fall back to a minted RAD-#### rather than fail the
 * upload or merge two pieces into one lot.
 */
import { prisma } from "@/db";
import { createInboundDocument } from "@/modules/ims/documents.service";
import { createInventoryItem, MINTED_SKU } from "@/modules/ims/inventory.service";
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

const PREFIX = "SMOKE-SKUCOPY";
const STYLE_A = `${PREFIX}-RP55X`;
const STYLE_B = `${PREFIX}-RP66Y`;
const STYLE_DUP = `${PREFIX}-DUPE`;
const STYLE_TAKEN = `${PREFIX}-TAKEN`;
const ASSIGNED = `${PREFIX}-ASSIGNED`;

function piece(vendorSku: string | null, over: Record<string, unknown> = {}): ImsInboundItemInput {
  return {
    itemType: "JEWELRY",
    itemName: `Hoops ${vendorSku ?? "(no style)"}`,
    ...(vendorSku ? { vendorSku } : {}),
    jewelry: {
      jewelryItemType: "Earrings",
      metal: "18k Yellow Gold",
      quantity: 1,
      productionCost: 400,
      wholesalePrice: 900
    },
    ...over
  } as unknown as ImsInboundItemInput;
}

/** Everything this run touched, by the one thing all of it has in common. */
async function cleanup(): Promise<void> {
  const items = await prisma.inventoryItem.findMany({
    where: { OR: [{ sku: { startsWith: PREFIX } }, { vendorSku: { startsWith: PREFIX } }] },
    select: { id: true }
  });
  const ids = items.map((i) => i.id);
  const docIds = ids.length
    ? [
        ...new Set(
          (
            await prisma.documentLineItem.findMany({
              where: { inventoryItemId: { in: ids } },
              select: { documentId: true }
            })
          ).map((l) => l.documentId)
        )
      ]
    : [];
  await prisma.documentLineItem.deleteMany({ where: { documentId: { in: docIds } } });
  await prisma.itemStatusHistory.deleteMany({ where: { inventoryItemId: { in: ids } } });
  await prisma.inventoryItem.deleteMany({ where: { id: { in: ids } } });
  await prisma.document.deleteMany({ where: { id: { in: docIds } } });
}

async function skuOf(itemId: string): Promise<string> {
  const it = await prisma.inventoryItem.findUniqueOrThrow({
    where: { id: itemId },
    select: { sku: true }
  });
  return it.sku;
}

async function main(): Promise<void> {
  const user = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
  const brand =
    (await prisma.company.findFirst({ where: { name: `${PREFIX} Designer` } })) ??
    (await prisma.company.create({ data: { name: `${PREFIX} Designer` } }));
  const vendor = await prisma.vendor.upsert({
    where: { name: `${PREFIX} Vendor` },
    create: { name: `${PREFIX} Vendor` },
    update: {}
  });

  await cleanup();

  console.log("\n1. New item form — one at a time");
  const one = await createInventoryItem({
    itemType: "JEWELRY",
    itemName: "Single hoop",
    vendorSku: STYLE_A,
    brandOwnerId: brand.id,
    jewelry: { jewelryItemType: "Earrings", quantity: 1, productionCost: 400 }
  } as never);
  check("created", one.ok, one.ok ? undefined : one.error);
  if (one.ok) check("takes the vendor SKU as its RADIIA SKU", one.item.sku === STYLE_A, one.item.sku);

  const bare = await createInventoryItem({
    itemType: "JEWELRY",
    itemName: "No style number",
    brandOwnerId: brand.id,
    jewelry: { jewelryItemType: "Ring", quantity: 1, productionCost: 200 }
  } as never);
  check("created without a vendor SKU", bare.ok, bare.ok ? undefined : bare.error);
  if (bare.ok) check("mints RAD-#### when there is nothing to copy", MINTED_SKU.test(bare.item.sku), bare.item.sku);

  // Same style number, second piece: the number is spoken for, so this one
  // needs an internal SKU rather than a unique-violation error.
  const clash = await createInventoryItem({
    itemType: "JEWELRY",
    itemName: "Same style, different piece",
    vendorSku: STYLE_A,
    brandOwnerId: brand.id,
    jewelry: { jewelryItemType: "Earrings", quantity: 1, productionCost: 400 }
  } as never);
  check("a taken style number still creates", clash.ok, clash.ok ? undefined : clash.error);
  if (clash.ok) check("falls back to a minted SKU", MINTED_SKU.test(clash.item.sku), clash.item.sku);
  if (clash.ok) check("keeps the vendor SKU on the item", clash.item.vendorSku === STYLE_A, clash.item.vendorSku);

  console.log("\n2. Brand In — the Reinstein Ross shape (style numbers, no RADIIA SKU column)");
  const bin = await createInboundDocument(
    {
      type: "BRAND_INVENTORY_IN",
      brandOwnerId: brand.id,
      items: [piece(STYLE_B), piece(null), piece(STYLE_DUP), piece(STYLE_DUP)]
    } as never,
    user.id
  );
  check("brand in created", bin.ok, bin.ok ? undefined : bin.error);
  if (bin.ok) {
    const skus = await Promise.all(bin.document.lineItems.map((l) => skuOf(l.inventoryItemId)));
    check("style number becomes the SKU", skus[0] === STYLE_B, skus[0]);
    check("no style number -> minted", MINTED_SKU.test(skus[1]), skus[1]);
    // A sheet listing one style twice is two distinct pieces (two sizes, say),
    // and only one of them can hold the number.
    check("first of a repeated style takes it", skus[2] === STYLE_DUP, skus[2]);
    check("second of a repeated style is minted", MINTED_SKU.test(skus[3]), skus[3]);
    check("the upload is not rejected over it", skus.length === 4, skus);
  }

  console.log("\n3. Bill In — a style number another vendor already used");
  const first = await createInboundDocument(
    { type: "BILL_IN", vendorId: vendor.id, items: [piece(STYLE_TAKEN)] } as never,
    user.id
  );
  check("first receipt created", first.ok, first.ok ? undefined : first.error);
  if (first.ok) {
    const sku = await skuOf(first.document.lineItems[0].inventoryItemId);
    check("takes the style number", sku === STYLE_TAKEN, sku);
  }

  const second = await createInboundDocument(
    { type: "BRAND_INVENTORY_IN", brandOwnerId: brand.id, items: [piece(STYLE_TAKEN)] } as never,
    user.id
  );
  check("second receipt of the same number created", second.ok, second.ok ? undefined : second.error);
  if (second.ok) {
    const sku = await skuOf(second.document.lineItems[0].inventoryItemId);
    // Two vendors may share a style number. Copying it would either fail on the
    // unique index or, worse, quietly merge unrelated stock.
    check("does not steal or merge — mints instead", MINTED_SKU.test(sku), sku);
  }

  console.log("\n4. An assigned RADIIA SKU still wins, and still tops up");
  const melee1 = await createInboundDocument(
    {
      type: "BILL_IN",
      vendorId: vendor.id,
      items: [
        {
          itemType: "STONE",
          itemSubtype: "PARCEL",
          sku: ASSIGNED,
          vendorSku: `${PREFIX}-VENDORSIDE`,
          stone: { gemType: "Diamond", shape: "Round", weightCt: 5, quantity: 20, costPerCt: 100 }
        }
      ]
    } as never,
    user.id
  );
  check("parcel received", melee1.ok, melee1.ok ? undefined : melee1.error);
  if (melee1.ok) {
    const sku = await skuOf(melee1.document.lineItems[0].inventoryItemId);
    check("the assigned SKU beats the vendor SKU", sku === ASSIGNED, sku);
  }

  const melee2 = await createInboundDocument(
    {
      type: "BILL_IN",
      vendorId: vendor.id,
      items: [
        {
          itemType: "STONE",
          itemSubtype: "PARCEL",
          sku: ASSIGNED,
          stone: { gemType: "Diamond", shape: "Round", weightCt: 3, quantity: 12, costPerCt: 100 }
        }
      ]
    } as never,
    user.id
  );
  check("same SKU received again", melee2.ok, melee2.ok ? undefined : melee2.error);
  if (melee1.ok && melee2.ok) {
    const same =
      melee1.document.lineItems[0].inventoryItemId === melee2.document.lineItems[0].inventoryItemId;
    check("tops the existing lot up rather than making a second one", same);
    const lot = await prisma.stoneDetail.findUniqueOrThrow({
      where: { inventoryItemId: melee2.document.lineItems[0].inventoryItemId },
      select: { weightCt: true }
    });
    check("carats added", Number(lot.weightCt) === 8, lot.weightCt.toString());
  }

  await cleanup();
  await prisma.company.deleteMany({ where: { id: brand.id } }).catch(() => undefined);
  await prisma.vendor.deleteMany({ where: { id: vendor.id } }).catch(() => undefined);

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
