/**
 * Lists RADIIA's own fancy-colour diamonds whose intensity is not recorded.
 *
 * Reads only — it writes a CSV and changes nothing. Scope is the InventoryItem /
 * Stone tables, which are RADIIA's stock; the Disons and Skylab feeds live in the
 * separate Diamond table and are the vendors' goods, so they are not touched.
 *
 * Rows land in one of two groups:
 *   recoverable — the colour was typed as one string ("Fancy Vivid Yellow"), so
 *                 the intensity is sitting in the text and can be split out.
 *   needs-input — only a hue was ever recorded, so the intensity is genuinely
 *                 unknown and somebody has to supply it.
 *
 *   npm run report:fancycolor        (dev)
 *   npm run report:fancycolor:prod   (live)
 */
import { writeFileSync } from "node:fs";

import { prisma } from "../src/db";
import { isFancyIntensity, parseFancyColor, stoneColorLabel } from "../src/domain";

/** Sold and returned goods are off the shelf — Jennifer asked for open stock. */
const OPEN_STATUSES = ["IN_STOCK", "RESERVED", "ON_MEMO"] as const;

type Row = {
  group: "recoverable" | "needs-input";
  sku: string;
  itemName: string;
  status: string;
  shape: string;
  caratCt: string;
  recorded: string;
  hue: string;
  suggestedIntensity: string;
  lab: string;
  certNumber: string;
  vendor: string;
};

/** These counts get quoted to the client, so they should read as English. */
function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

async function main(): Promise<void> {
  const items = await prisma.inventoryItem.findMany({
    where: { itemType: "STONE", stone: { isNot: null } },
    include: { stone: true, vendor: { select: { name: true } } },
    orderBy: { sku: "asc" }
  });

  const open: Row[] = [];
  const closed: Row[] = [];
  let alreadyGraded = 0;

  // An empty report is a claim about the data, so gather the evidence for it:
  // what gem types exist, and whether anything looks fancy under a gem type the
  // filter below would skip. Without this, a mis-typed gemType reads as "none".
  const gemTypes = new Map<string, number>();
  const missedByGemFilter: string[] = [];

  for (const item of items) {
    const stone = item.stone!;
    const gem = stone.gemType ?? "(not set)";
    gemTypes.set(gem, (gemTypes.get(gem) ?? 0) + 1);
    // A gemstone's colour is not a fancy diamond grade, so only diamonds qualify.
    if (!/diamond/i.test(stone.gemType ?? "")) {
      const looksFancy = parseFancyColor(stone.fancyColor ?? stone.color).fancyColor;
      if (looksFancy)
        missedByGemFilter.push(`${item.sku} (${gem}) — ${stoneColorLabel(stone) ?? ""}`);
      continue;
    }
    if (stone.fancyIntensity) {
      alreadyGraded += 1;
      continue;
    }

    const recorded = stoneColorLabel(stone) ?? "";
    const parsed = parseFancyColor(stone.fancyColor ?? stone.color);
    // No hue means a plain white grade (G, H…) or nothing at all — not our case.
    if (!parsed.fancyColor) continue;

    const row: Row = {
      group: parsed.fancyIntensity ? "recoverable" : "needs-input",
      sku: item.sku,
      itemName: item.itemName ?? "",
      status: item.status,
      shape: stone.shape ?? "",
      caratCt: stone.weightCt === null ? "" : String(Number(stone.weightCt)),
      recorded,
      hue: parsed.fancyColor,
      suggestedIntensity: parsed.fancyIntensity ?? "",
      lab: stone.lab ?? "",
      certNumber: stone.certNumber ?? "",
      vendor: item.vendor?.name ?? ""
    };

    if ((OPEN_STATUSES as readonly string[]).includes(item.status)) open.push(row);
    else closed.push(row);
  }

  const needsInput = open.filter((r) => r.group === "needs-input");
  const recoverable = open.filter((r) => r.group === "recoverable");

  const header = [
    "SKU", "Item name", "Status", "Shape", "Carat",
    "Colour on record", "Colour (hue)", "Intensity — please fill in",
    "Lab", "Cert #", "Vendor"
  ];
  // The intensity column is pre-filled where we could recover it, so the sheet
  // doubles as the confirmation list and as the blanks to complete.
  const lines = [header.join(",")].concat(
    open.map((r) =>
      [
        r.sku, r.itemName, r.status, r.shape, r.caratCt,
        r.recorded, r.hue, r.suggestedIntensity,
        r.lab, r.certNumber, r.vendor
      ].map(csvCell).join(",")
    )
  );

  const out = process.env.FANCY_REPORT_OUT ?? "fancy-color-stones.csv";
  writeFileSync(out, lines.join("\r\n") + "\r\n", "utf8");

  console.log(`Scanned ${items.length} RADIIA stones (the Disons/Skylab feeds are a separate table and were not read).`);
  console.log(`  ${alreadyGraded} ${plural(alreadyGraded, "already carries", "already carry")} an intensity — nothing to do.`);
  console.log("");
  console.log(`Open stock missing an intensity: ${open.length}`);
  console.log(`  ${recoverable.length} recoverable — the intensity is in the recorded text and can be split out automatically.`);
  console.log(`  ${needsInput.length} need input — only a hue was ever recorded.`);
  if (closed.length > 0)
    console.log(`Also ${closed.length} sold/returned ${plural(closed.length, "stone is", "stones are")} affected, left out of the CSV.`);
  console.log("");
  console.log(`Wrote ${open.length} rows to ${out}`);

  if (open.length === 0 && closed.length === 0) {
    console.log("\nNothing matched — the evidence for that:");
    const byCount = [...gemTypes.entries()].sort((a, b) => b[1] - a[1]);
    for (const [gem, count] of byCount.slice(0, 12))
      console.log(`  ${String(count).padStart(5)}  ${gem}`);
    if (byCount.length > 12) console.log(`  … and ${byCount.length - 12} more gem types`);
    console.log(
      missedByGemFilter.length === 0
        ? "  No stone of ANY gem type carries a fancy-looking colour, so this is a real zero."
        : `  ${missedByGemFilter.length} non-diamond ${plural(missedByGemFilter.length, "stone has", "stones have")} a fancy-looking colour — check whether the gem type is wrong:`
    );
    missedByGemFilter.slice(0, 20).forEach((s) => console.log(`    ${s}`));
  }

  const withCert = needsInput.filter((r) => r.certNumber).length;
  if (withCert > 0)
    console.log(`Of the ${needsInput.length} needing input, ${withCert} ${plural(withCert, "has", "have")} a cert number — those could be filled from the lab report instead of by hand.`);

  const oddIntensities = recoverable
    .map((r) => r.suggestedIntensity)
    .filter((v) => !isFancyIntensity(v));
  if (oddIntensities.length > 0)
    console.log(`Check by hand — unrecognised intensities: ${[...new Set(oddIntensities)].join(", ")}`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
