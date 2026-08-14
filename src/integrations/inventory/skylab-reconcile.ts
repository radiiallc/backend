
import { prisma } from "@/db";

import { fetchSkylabStock, type SkylabStone } from "./skylab-api";
import { isSkylabAvailable, parseSkylabStock, skylabLotStatus } from "./skylab-adapter";

const EXAMPLE_CAP = 50;

const PRICE_DIFF_REL = 0.02;

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
    total: number;
    available: number;
    usable: number;
    withoutCert: number;
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
    leakingCount: number;
    leakingExamples: ReconcileExample[];
    newInApiCount: number;
    newInApiExamples: ReconcileExample[];
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

  const statusDist = new Map<string, number>();
  const shapeDist = new Map<string, number>();
  for (const stone of stones) {
    bump(statusDist, skylabLotStatus(stone) || "(blank)");
    if (isSkylabAvailable(stone)) bump(shapeDist, rawShape(stone));
  }

  const availableCount = stones.filter(isSkylabAvailable).length;

  const usable = parseSkylabStock(stones).rows;
  const apiByCert = new Map<string, (typeof usable)[number]>();
  let apiWithoutCert = 0;
  for (const row of usable) {
    const cert = normCert(row.certNumber);
    if (cert) apiByCert.set(cert, row);
    else apiWithoutCert++;
  }

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
