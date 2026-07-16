// Skylab API ↔ DB reconciliation (WORKPLAN §1.6).
//
// Read-only. Fetches the Skylab API, normalizes it, and compares against the
// current DB Skylab rows WITHOUT writing anything. This powers the "run API + FTP
// in parallel ~2 weeks, reconcile, then drop FTP" validation phase: while the FTP
// feed still drives the live table, this shows what the API would change — most
// importantly the availability leaks (stones the portal shows as available that
// the API reports are not, i.e. the 638-025ADA class of bug).
//
// It also surfaces the two things still unconfirmed with Skylab: the real
// lot_status vocabulary (statusDistribution) and the shape spelling
// (shapeDistribution), so the mapping can be verified against live data.

import { prisma } from "@/db";

import { fetchSkylabStock, type SkylabStone } from "./skylab-api";
import { isSkylabAvailable, parseSkylabStock, skylabLotStatus } from "./skylab-adapter";

// Cap example arrays so a report over ~8k stones stays readable; counts are always
// exact, only the illustrative lists are truncated.
const EXAMPLE_CAP = 50;

// Relative price-per-carat delta above which a matched stone is flagged as a diff.
const PRICE_DIFF_REL = 0.02; // 2%

export type ReconcileExample = {
  certNumber: string | null;
  sku: string | null;
  shape?: string | null;
  dbPricePerCt?: number | null;
  apiPricePerCt?: number | null;
};

export type SkylabReconcileReport = {
  fetchedAt: string;
  api: {
    total: number; // stones returned by the API
    available: number; // lot_status in the allow-list
    usable: number; // available AND has a lot_no/cert (ingestable)
    withoutCert: number; // usable rows the API sent with no certificate
    statusDistribution: Record<string, number>;
    shapeDistribution: Record<string, number>;
  };
  db: {
    skylabTotal: number;
    skylabAvailable: number;
    availableWithoutCert: number;
  };
  reconcile: {
    matchedByCert: number;
    // DB shows available, API does not list it as available → would be swept to
    // unavailable at cutover. The headline metric (the leaking-stone fix).
    leakingCount: number;
    leakingExamples: ReconcileExample[];
    // API available, not present in the DB at all → new stones cutover would add.
    newInApiCount: number;
    newInApiExamples: ReconcileExample[];
    // Present in both, price-per-carat differs beyond the threshold.
    priceDiffCount: number;
    priceDiffExamples: ReconcileExample[];
  };
};

function normCert(cert: string | null | undefined): string | null {
  if (!cert) return null;
  const t = String(cert).trim().toUpperCase();
  return t === "" ? null : t;
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function rawShape(stone: SkylabStone): string {
  const s = stone.shape;
  return (s === null || s === undefined ? "" : String(s).trim()) || "(blank)";
}

export async function reconcileSkylab(): Promise<SkylabReconcileReport> {
  const { stones } = await fetchSkylabStock();

  // Distributions over the whole payload (discovery aids).
  const statusDist = new Map<string, number>();
  const shapeDist = new Map<string, number>();
  for (const stone of stones) {
    bump(statusDist, skylabLotStatus(stone) || "(blank)");
    if (isSkylabAvailable(stone)) bump(shapeDist, rawShape(stone));
  }

  const availableCount = stones.filter(isSkylabAvailable).length;

  // Normalized, ingestable (available + has id) rows.
  const usable = parseSkylabStock(stones).rows;
  const apiByCert = new Map<string, (typeof usable)[number]>();
  let apiWithoutCert = 0;
  for (const row of usable) {
    const cert = normCert(row.certNumber);
    if (cert) apiByCert.set(cert, row);
    else apiWithoutCert++;
  }

  // Current DB Skylab rows (all, so "new in API" excludes ones we already store
  // even if currently unavailable).
  const dbRows = await prisma.diamond.findMany({
    where: { vendor: "Skylab" },
    select: { certNumber: true, sku: true, isAvailable: true, basePricePerCtUsd: true }
  });

  const dbByCert = new Map<string, (typeof dbRows)[number]>();
  let dbAvailable = 0;
  let dbAvailableWithoutCert = 0;
  for (const row of dbRows) {
    if (row.isAvailable) dbAvailable++;
    const cert = normCert(row.certNumber);
    if (cert) dbByCert.set(cert, row);
    else if (row.isAvailable) dbAvailableWithoutCert++;
  }

  const leaking: ReconcileExample[] = [];
  const priceDiffs: ReconcileExample[] = [];
  let matched = 0;

  for (const [cert, dbRow] of dbByCert) {
    if (!dbRow.isAvailable) continue;
    const apiRow = apiByCert.get(cert);
    if (!apiRow) {
      // Available in DB, but the API doesn't list it as available → a leak.
      leaking.push({ certNumber: dbRow.certNumber, sku: dbRow.sku });
      continue;
    }
    matched++;
    const dbPpc = dbRow.basePricePerCtUsd === null ? null : Number(dbRow.basePricePerCtUsd);
    const apiPpc = apiRow.basePricePerCtUsd;
    if (
      dbPpc !== null &&
      apiPpc !== null &&
      Math.abs(dbPpc - apiPpc) > Math.max(1, Math.abs(dbPpc) * PRICE_DIFF_REL)
    ) {
      priceDiffs.push({
        certNumber: dbRow.certNumber,
        sku: dbRow.sku,
        dbPricePerCt: dbPpc,
        apiPricePerCt: apiPpc
      });
    }
  }

  const newInApi: ReconcileExample[] = [];
  for (const [cert, apiRow] of apiByCert) {
    if (!dbByCert.has(cert)) {
      newInApi.push({ certNumber: apiRow.certNumber, sku: apiRow.sku, shape: apiRow.shapeRaw });
    }
  }

  return {
    fetchedAt: new Date().toISOString(),
    api: {
      total: stones.length,
      available: availableCount,
      usable: usable.length,
      withoutCert: apiWithoutCert,
      statusDistribution: Object.fromEntries(statusDist),
      shapeDistribution: Object.fromEntries(shapeDist)
    },
    db: {
      skylabTotal: dbRows.length,
      skylabAvailable: dbAvailable,
      availableWithoutCert: dbAvailableWithoutCert
    },
    reconcile: {
      matchedByCert: matched,
      leakingCount: leaking.length,
      leakingExamples: leaking.slice(0, EXAMPLE_CAP),
      newInApiCount: newInApi.length,
      newInApiExamples: newInApi.slice(0, EXAMPLE_CAP),
      priceDiffCount: priceDiffs.length,
      priceDiffExamples: priceDiffs.slice(0, EXAMPLE_CAP)
    }
  };
}
