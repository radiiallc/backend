// Parcel draw-down smoke — exercises the whole draw/reverse cycle against
// radiia_dev at the service layer. Run: npm run smoke:parcel
import { prisma } from "@/db";
import { createOutboundDocument, voidDocument } from "@/modules/ims/documents.service";
import {
  adjustParcelRemaining,
  createInventoryItem,
  updateInventoryItem
} from "@/modules/ims/inventory.service";

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

async function balance(id: string): Promise<{ ct: number | null; qty: number | null; status: string }> {
  const it = await prisma.inventoryItem.findUniqueOrThrow({
    where: { id },
    include: { stone: true }
  });
  return {
    ct: it.stone?.remainingCt === null || it.stone?.remainingCt === undefined
      ? null
      : Number(it.stone.remainingCt.toString()),
    qty: it.stone?.remainingQty ?? null,
    status: it.status
  };
}

async function main(): Promise<void> {
  // ── fixtures ──────────────────────────────────────────────────────────────
  const user = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
  const vendor = await prisma.vendor.upsert({
    where: { name: "SMOKE Parcel Vendor" },
    create: { name: "SMOKE Parcel Vendor" },
    update: {}
  });
  const client =
    (await prisma.company.findFirst({ where: { name: "SMOKE Parcel Client" } })) ??
    (await prisma.company.create({ data: { name: "SMOKE Parcel Client" } }));

  const stamp = Date.now();

  const mkParcel = async (weightCt: number, quantity: number | null, ppc: number) => {
    const r = await createInventoryItem({
      itemType: "STONE",
      itemSubtype: "PARCEL",
      vendorId: vendor.id,
      itemName: `SMOKE parcel ${stamp}`,
      stone: {
        shape: "Round",
        gemType: "Ruby",
        weightCt,
        quantity,
        wholesalePricePerCt: ppc,
        costPerCt: ppc / 2
      }
    } as never);
    if (!r.ok) throw new Error(`fixture parcel failed: ${r.error}`);
    return r.item.id;
  };

  const mkSingle = async (weightCt: number, ppc: number) => {
    const r = await createInventoryItem({
      itemType: "STONE",
      itemSubtype: "SINGLE",
      vendorId: vendor.id,
      itemName: `SMOKE single ${stamp}`,
      stone: { shape: "Round", weightCt, wholesalePricePerCt: ppc, naturalOrLab: "NATURAL" }
    } as never);
    if (!r.ok) throw new Error(`fixture single failed: ${r.error}`);
    return r.item.id;
  };

  const inv = (lines: unknown[]) =>
    createOutboundDocument(
      { type: "INVOICE", clientId: client.id, lines } as never,
      user.id
    );

  // ── 1. opening balance ────────────────────────────────────────────────────
  console.log("\n[1] opening balance");
  const p = await mkParcel(16.76, 49, 500);
  let b = await balance(p);
  check("parcel initialises remainingCt = weightCt", b.ct === 16.76, b);
  check("parcel initialises remainingQty = quantity", b.qty === 49, b);
  check("parcel starts IN_STOCK", b.status === "IN_STOCK", b);

  const single = await mkSingle(1.5, 4000);
  const sb = await balance(single);
  check("single stone gets NO balance (stays atomic)", sb.ct === null && sb.qty === null, sb);

  // ── 2. the core draw ──────────────────────────────────────────────────────
  console.log("\n[2] partial draw");
  const d1 = await inv([{ inventoryItemId: p, caratWeight: 0.4, quantity: 2 }]);
  check("0.40 ct draw succeeds", d1.ok, d1.ok ? undefined : d1.error);
  b = await balance(p);
  check("remaining 16.76 - 0.40 = 16.36", b.ct === 16.36, b);
  check("pieces 49 - 2 = 47", b.qty === 47, b);
  check("parcel STAYS IN_STOCK after partial draw", b.status === "IN_STOCK", b);
  if (d1.ok) {
    const line = d1.document.lineItems[0];
    check("line prices the SLICE not the lot (0.40 x 500 = 200)", line?.totalPrice === 200, line);
    check("line carries the drawn carat weight", Number(line?.caratWeight) === 0.4, line);
    check("line carries the drawn piece count", Number(line?.quantity) === 2, line);
  }

  // ── 3. rejections (nothing may be half-written) ────────────────────────────
  console.log("\n[3] rejections");
  const over = await inv([{ inventoryItemId: p, caratWeight: 100 }]);
  check("over-draw rejected", !over.ok, over.ok ? "accepted!" : over.error);
  b = await balance(p);
  check("over-draw left the balance untouched", b.ct === 16.36, b);

  const overQty = await inv([{ inventoryItemId: p, caratWeight: 1, quantity: 999 }]);
  check("piece over-draw rejected", !overQty.ok, overQty.ok ? "accepted!" : overQty.error);

  const partialSingle = await inv([{ inventoryItemId: single, caratWeight: 0.5 }]);
  check(
    "partial draw on a SINGLE rejected",
    !partialSingle.ok,
    partialSingle.ok ? "accepted!" : partialSingle.error
  );

  const memo = await createOutboundDocument(
    { type: "MEMO_OUT", clientId: client.id, lines: [{ inventoryItemId: p }] } as never,
    user.id
  );
  check("parcel on a MEMO_OUT rejected (invoice-only pilot)", !memo.ok, memo.ok ? "accepted!" : memo.error);

  const dupe = await inv([
    { inventoryItemId: p, caratWeight: 0.1 },
    { inventoryItemId: p, caratWeight: 0.2 }
  ]);
  check("same parcel twice on one doc rejected", !dupe.ok, dupe.ok ? "accepted!" : dupe.error);

  const ctOnly = await mkParcel(10, null, 300);
  const qtyOnCtOnly = await inv([{ inventoryItemId: ctOnly, caratWeight: 1, quantity: 3 }]);
  check(
    "piece count on a carat-only parcel rejected",
    !qtyOnCtOnly.ok,
    qtyOnCtOnly.ok ? "accepted!" : qtyOnCtOnly.error
  );

  // ── 4. drawing the lot to zero ────────────────────────────────────────────
  console.log("\n[4] draw to zero");
  const d2 = await inv([{ inventoryItemId: p, caratWeight: 16.36, quantity: 47 }]);
  check("final draw succeeds", d2.ok, d2.ok ? undefined : d2.error);
  b = await balance(p);
  check("remaining hits exactly 0", b.ct === 0, b);
  check("pieces hit 0", b.qty === 0, b);
  check("parcel flips to SOLD only at zero", b.status === "SOLD", b);

  const afterSold = await inv([{ inventoryItemId: p, caratWeight: 0.1 }]);
  check("cannot draw from a SOLD parcel", !afterSold.ok, afterSold.ok ? "accepted!" : afterSold.error);

  // ── 5. void = reverse ─────────────────────────────────────────────────────
  console.log("\n[5] void reverses the draw");
  if (d2.ok) {
    const v = await voidDocument(d2.document.id, user.id);
    check("void succeeds", v.ok, v.ok ? undefined : v.error);
    check("voided doc is VOID", v.ok && v.document.status === "VOID", v.ok ? v.document.status : v);
    b = await balance(p);
    check("carats restored to 16.36", b.ct === 16.36, b);
    check("pieces restored to 47", b.qty === 47, b);
    check("parcel back to IN_STOCK", b.status === "IN_STOCK", b);

    const twice = await voidDocument(d2.document.id, user.id);
    check("double void rejected", !twice.ok, twice.ok ? "accepted!" : twice.error);
  }

  // ── 6. void a whole-item invoice (regression) ─────────────────────────────
  console.log("\n[6] whole-item regression");
  const legacy = await createOutboundDocument(
    { type: "INVOICE", clientId: client.id, inventoryItemIds: [single] } as never,
    user.id
  );
  check("legacy inventoryItemIds payload still works", legacy.ok, legacy.ok ? undefined : legacy.error);
  let ss = await balance(single);
  check("single stone sells whole -> SOLD", ss.status === "SOLD", ss);
  if (legacy.ok) {
    check(
      "single stone priced at full weight (1.5 x 4000)",
      legacy.document.lineItems[0]?.totalPrice === 6000,
      legacy.document.lineItems[0]
    );
    const v2 = await voidDocument(legacy.document.id, user.id);
    check("void restores a whole item", v2.ok, v2.ok ? undefined : v2.error);
    ss = await balance(single);
    check("single stone back to IN_STOCK", ss.status === "IN_STOCK", ss);
  }

  // ── 7. adjust / write-off ─────────────────────────────────────────────────
  console.log("\n[7] adjust remaining");
  const dust = await mkParcel(5, 20, 250);
  await inv([{ inventoryItemId: dust, caratWeight: 4.98, quantity: 20 }]);
  b = await balance(dust);
  check("0.02 ct crumb left after drawing 4.98", b.ct === 0.02, b);
  check("crumb parcel still IN_STOCK", b.status === "IN_STOCK", b);

  const adj = await adjustParcelRemaining(
    dust,
    { remainingCt: 0, reason: "0.02 ct dust, unsellable" },
    user.id
  );
  check("write-off succeeds", adj.ok, adj.ok ? undefined : adj.error);
  b = await balance(dust);
  check("written-off parcel reads 0 ct", b.ct === 0, b);
  check("written-off parcel closes as SOLD", b.status === "SOLD", b);

  const hist = await prisma.itemStatusHistory.findFirst({
    where: { inventoryItemId: dust, note: { not: null } },
    orderBy: { changedAt: "desc" }
  });
  check("write-off reason is audited", Boolean(hist?.note?.includes("unsellable")), hist?.note);

  const negative = await adjustParcelRemaining(dust, { remainingCt: -1, reason: "x" }, user.id);
  check("negative adjustment rejected", !negative.ok, negative.ok ? "accepted!" : negative.error);

  const adjSingle = await adjustParcelRemaining(single, { remainingCt: 1, reason: "x" }, user.id);
  check("adjusting a non-parcel rejected", !adjSingle.ok, adjSingle.ok ? "accepted!" : adjSingle.error);

  // ── 8. correcting a typo before anything sells ────────────────────────────
  console.log("\n[8] weight correction");
  const typo = await mkParcel(100, 10, 200);
  await updateInventoryItem(typo, { stone: { weightCt: 10 } } as never);
  b = await balance(typo);
  check("untouched parcel: weight fix carries the balance", b.ct === 10, b);

  const drawn = await mkParcel(20, null, 100);
  await inv([{ inventoryItemId: drawn, caratWeight: 5 }]);
  await updateInventoryItem(drawn, { stone: { weightCt: 30 } } as never);
  b = await balance(drawn);
  check("part-drawn parcel: weight edit does NOT reset the balance", b.ct === 15, b);

  // ── cleanup ───────────────────────────────────────────────────────────────
  // Leave radiia_dev as we found it, so the smoke is repeatable and does not
  // slowly fill the dev DB with fixtures.
  const mine = await prisma.inventoryItem.findMany({
    where: { vendorId: vendor.id },
    select: { id: true }
  });
  const mineIds = mine.map((i) => i.id);
  const docIds = (
    await prisma.document.findMany({ where: { clientId: client.id }, select: { id: true } })
  ).map((d) => d.id);

  await prisma.documentLineItem.deleteMany({ where: { documentId: { in: docIds } } });
  await prisma.itemStatusHistory.deleteMany({ where: { inventoryItemId: { in: mineIds } } });
  await prisma.document.deleteMany({ where: { id: { in: docIds } } });
  await prisma.inventoryItem.deleteMany({ where: { id: { in: mineIds } } });
  await prisma.company.delete({ where: { id: client.id } }).catch(() => undefined);
  await prisma.vendor.delete({ where: { id: vendor.id } }).catch(() => undefined);
  console.log(`\ncleaned up ${mineIds.length} item(s), ${docIds.length} doc(s)`);

  // ── summary ───────────────────────────────────────────────────────────────
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
