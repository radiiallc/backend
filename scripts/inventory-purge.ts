// Inspect / delete inventory items by SKU.
//
// There is no DELETE route on /ims by design — inventory leaves stock through a
// document, never by vanishing. That leaves no way to clear rows that should
// never have existed (a mistyped test import, goods received under the wrong
// vendor), which is what this script is for. It is deliberately a script and not
// an endpoint: deleting stock is not a routine operation and should not be one
// click away in the admin.
//
// Usage:
//   npm run purge:inspect:prod -- SKU-1 SKU-2      (read-only; always run first)
//   npm run purge:delete:prod  -- SKU-1 SKU-2 --yes
//
// Refuses to delete anything with history that implies the goods really moved:
// a line on a document that is not a plain inbound receipt, or a parcel that has
// already been drawn down. Those are ledger facts, and unpicking them silently
// would be worse than the stray row.

import { prisma } from "@/db";

const INBOUND_TYPES = new Set(["BILL_IN", "MEMO_IN", "BRAND_INVENTORY_IN"]);

type Blocker = { sku: string; reason: string };

async function main() {
  const argv = process.argv.slice(2);
  const confirmed = argv.includes("--yes");
  const skus = argv.filter((a) => !a.startsWith("--"));

  if (skus.length === 0) {
    console.error("Pass at least one SKU. Example: -- RUEM-4x3 RU1-14");
    process.exit(1);
  }

  const items = await prisma.inventoryItem.findMany({
    where: { sku: { in: skus } },
    include: {
      stone: true,
      jewelry: true,
      material: true,
      vendor: { select: { name: true } },
      statusHistory: { select: { id: true } },
      substituteRequestItems: { select: { id: true } },
      lineItems: {
        include: {
          document: {
            select: { id: true, type: true, documentNumber: true, externalReference: true, status: true }
          }
        }
      }
    }
  });

  const found = new Set(items.map((i) => i.sku));
  for (const sku of skus) {
    if (!found.has(sku)) console.log(`· ${sku} — not in inventory (nothing to do)`);
  }

  const blockers: Blocker[] = [];

  for (const item of items) {
    const detail = item.stone
      ? `${item.stone.shape} ${item.stone.weightCt} ct` +
        (item.stone.remainingCt !== null ? ` · ${item.stone.remainingCt} ct remaining` : "")
      : item.jewelry
        ? `${item.jewelry.jewelryItemType} ×${item.jewelry.quantity}`
        : item.material
          ? `${item.material.subtype} ×${item.material.quantity}`
          : "(no detail row)";

    console.log(
      [
        ``,
        `${item.sku}  ${item.itemName ?? "(unnamed)"}`,
        `  type      ${item.itemType}${item.itemSubtype ? ` / ${item.itemSubtype}` : ""}`,
        `  detail    ${detail}`,
        `  status    ${item.status}`,
        `  vendor    ${item.vendor?.name ?? "(none)"}`,
        `  created   ${item.createdAt.toISOString()}`,
        `  on docs   ${item.lineItems.length}`,
        `  audit     ${item.statusHistory.length} status row(s)`,
        `  requests  ${item.substituteRequestItems.length} substitute reference(s)`
      ].join("\n")
    );

    for (const line of item.lineItems) {
      const d = line.document;
      const label = d.documentNumber ?? d.externalReference ?? "(no reference)";
      console.log(`    ← ${d.type} ${label} [${d.status}] line ${line.lineStatus}`);
      if (!INBOUND_TYPES.has(d.type)) {
        blockers.push({
          sku: item.sku,
          reason: `sits on ${d.type} ${label} — the goods have moved, delete would rewrite the ledger`
        });
      }
    }

    // A parcel that has been partly invoiced is a live position, whatever its
    // document trail looks like.
    if (item.stone && item.itemSubtype === "PARCEL" && item.stone.remainingCt !== null) {
      const original = Number(item.stone.weightCt.toString());
      const remaining = Number(item.stone.remainingCt.toString());
      if (remaining < original - 1e-6) {
        blockers.push({
          sku: item.sku,
          reason: `parcel already drawn down (${remaining} of ${original} ct left)`
        });
      }
    }

    if (item.substituteRequestItems.length > 0) {
      blockers.push({
        sku: item.sku,
        reason: `referenced as a substitute on ${item.substituteRequestItems.length} request(s)`
      });
    }
  }

  console.log("");

  if (blockers.length > 0) {
    console.log("REFUSING TO DELETE:");
    for (const b of blockers) console.log(`  ✗ ${b.sku} — ${b.reason}`);
    console.log("\nResolve these by hand, or drop the SKU from the argument list.");
    process.exit(1);
  }

  if (items.length === 0) {
    console.log("Nothing to delete.");
    return;
  }

  if (!confirmed) {
    console.log(`DRY RUN — would delete ${items.length} item(s): ${items.map((i) => i.sku).join(", ")}`);
    console.log("Re-run with --yes to actually delete.");
    return;
  }

  // Detail rows cascade on the item (schema onDelete: Cascade). Line items and
  // status history do not, so they go first — and any inbound document left with
  // no lines at all goes too, because an empty bill is not a record of anything.
  const itemIds = items.map((i) => i.id);
  const touchedDocIds = Array.from(
    new Set(items.flatMap((i) => i.lineItems.map((l) => l.documentId)))
  );

  const result = await prisma.$transaction(async (tx) => {
    const lines = await tx.documentLineItem.deleteMany({ where: { inventoryItemId: { in: itemIds } } });
    const history = await tx.itemStatusHistory.deleteMany({ where: { inventoryItemId: { in: itemIds } } });
    const deleted = await tx.inventoryItem.deleteMany({ where: { id: { in: itemIds } } });

    const emptied: string[] = [];
    for (const docId of touchedDocIds) {
      const remaining = await tx.documentLineItem.count({ where: { documentId: docId } });
      if (remaining === 0) {
        const doc = await tx.document.delete({ where: { id: docId } });
        emptied.push(doc.documentNumber ?? doc.externalReference ?? doc.id);
      }
    }
    return { lines: lines.count, history: history.count, items: deleted.count, emptied };
  });

  console.log(
    `Deleted ${result.items} item(s), ${result.lines} document line(s), ${result.history} audit row(s).`
  );
  if (result.emptied.length > 0) {
    console.log(`Removed ${result.emptied.length} now-empty document(s): ${result.emptied.join(", ")}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
