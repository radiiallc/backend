// TEMP smoke — drives the real lookupGiaReport service against GIA's sandbox.
// Run: GIA_API_KEY=<sandbox> npx dotenv -e .env.dev -- npx tsx tmp-gia-smoke.ts
// Deleted after verification. Uses only GIA's published sandbox report numbers.
import { lookupGiaReport } from "./src/modules/ims/gia.service";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, got?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label} — got: ${JSON.stringify(got)}`);
  }
}

async function main() {
  // 1) Natural diamond dossier (with cut grade).
  const nat = await lookupGiaReport("2141438172");
  console.log("\n[1] NATURAL 2141438172:", JSON.stringify(nat, null, 2).slice(0, 900));
  check("found", nat.found, nat.found);
  check("supported", nat.supported, nat.supported);
  check("naturalOrLab NATURAL", nat.prefill?.naturalOrLab === "NATURAL", nat.prefill?.naturalOrLab);
  check("shape Round Brilliant", nat.prefill?.shape === "Round Brilliant", nat.prefill?.shape);
  check("weightCt 1.01", nat.prefill?.weightCt === 1.01, nat.prefill?.weightCt);
  check("color G", nat.prefill?.color === "G", nat.prefill?.color);
  check("clarity SI2", nat.prefill?.clarity === "SI2", nat.prefill?.clarity);
  check("lab GIA", nat.prefill?.lab === "GIA", nat.prefill?.lab);
  check("certNumber echoes report", nat.prefill?.certNumber === "2141438172", nat.prefill?.certNumber);
  check("quotaRemaining is a number", typeof nat.quotaRemaining === "number", nat.quotaRemaining);
  await sleep(1300);

  // 2) Lab-grown — exercises measurements + proportions + links parsing.
  const lab = await lookupGiaReport("5202397873");
  console.log("\n[2] LAB-GROWN 5202397873:", JSON.stringify({ ...lab, links: lab.links ? { pdf: (lab.links.pdf || "").slice(0, 40) + "…" } : null }, null, 2).slice(0, 900));
  check("naturalOrLab LAB", lab.prefill?.naturalOrLab === "LAB", lab.prefill?.naturalOrLab);
  check("weightCt 1.32", lab.prefill?.weightCt === 1.32, lab.prefill?.weightCt);
  check("length 7.03", lab.prefill?.lengthMm === 7.03, lab.prefill?.lengthMm);
  check("width 7.07", lab.prefill?.widthMm === 7.07, lab.prefill?.widthMm);
  check("height 4.35", lab.prefill?.heightMm === 4.35, lab.prefill?.heightMm);
  check("tablePct 58", lab.prefill?.tablePct === 58, lab.prefill?.tablePct);
  check("depthPct 61.7", lab.prefill?.depthPct === 61.7, lab.prefill?.depthPct);
  check("cutGrade Excellent", lab.prefill?.cutGrade === "Excellent", lab.prefill?.cutGrade);
  check("pdf link present", !!lab.links?.pdf, lab.links?.pdf ? "yes" : "no");
  await sleep(1300);

  // 3) Colored stone (emerald) — IdentificationReportResults, naturalOrLab null.
  const cs = await lookupGiaReport("2141438184");
  console.log("\n[3] COLORED STONE 2141438184:", JSON.stringify({ ...cs, links: cs.links ? { pdf: "…" } : null }, null, 2).slice(0, 900));
  check("found & supported", cs.found && cs.supported, { f: cs.found, s: cs.supported });
  check("naturalOrLab null", cs.prefill?.naturalOrLab === null, cs.prefill?.naturalOrLab);
  check("shape Octagonal", cs.prefill?.shape === "Octagonal", cs.prefill?.shape);
  check("weightCt 5.66", cs.prefill?.weightCt === 5.66, cs.prefill?.weightCt);
  check("measurements 3 dims", cs.prefill?.lengthMm === 10.95 && cs.prefill?.heightMm === 7.74, { l: cs.prefill?.lengthMm, h: cs.prefill?.heightMm });
  check("treatment mapped", (cs.prefill?.treatment || "").startsWith("Clarity Enhanced"), cs.prefill?.treatment);
  check("origin placeholder nulled (Not Requested)", cs.prefill?.origin === null, cs.prefill?.origin);
  await sleep(1300);

  // 4) Not found.
  const nf = await lookupGiaReport("9999999999");
  console.log("\n[4] NOT FOUND 9999999999:", JSON.stringify(nf).slice(0, 300));
  check("found false", nf.found === false, nf.found);
  check("has error message", !!nf.error, nf.error);
  await sleep(1300);

  // 5) Pearl (unsupported kind).
  const pearl = await lookupGiaReport("2141438190");
  console.log("\n[5] PEARL 2141438190:", JSON.stringify({ ...pearl, links: pearl.links ? { pdf: "…" } : null }).slice(0, 400));
  check("found true", pearl.found === true, pearl.found);
  check("supported false", pearl.supported === false, pearl.supported);
  check("prefill null", pearl.prefill === null, pearl.prefill);
  check("error explains manual entry", /manual/i.test(pearl.error || ""), pearl.error);

  console.log(`\n===== GIA SMOKE: ${pass} passed, ${fail} failed =====`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("SMOKE ERROR:", e);
  process.exit(1);
});
