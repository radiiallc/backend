// Auto-calc fields for a stone (§5 D3 — app-layer compute, not Postgres
// generated columns). This is the single source of truth referenced by the plan
// ("seed inlines the same math"); keep it byte-identical to prisma/seed.ts.
//
//   ratio               = lengthMm / widthMm
//   totalWholesalePrice = weightCt × wholesalePricePerCt
//   totalCost           = weightCt × costPerCt
//
// `weightCt` is the TOTAL carat of the item (for a parcel it's the whole-parcel
// carat, for a pair it's the matched-pair total), so the totals do NOT multiply
// by quantity — the weight already accounts for it (matches the seed).

// The seed uses a single 2dp rounder for all three derived fields; we mirror it
// so a row produced by computeDerived() is identical to the seeded equivalent.
const round2 = (n: number): number => Math.round(n * 100) / 100;

export type StoneDerivedInput = {
  lengthMm?: number | null;
  widthMm?: number | null;
  weightCt?: number | null;
  wholesalePricePerCt?: number | null;
  costPerCt?: number | null;
};

export type StoneDerived = {
  ratio: number | null;
  totalWholesalePrice: number | null;
  totalCost: number | null;
};

export function computeDerived(input: StoneDerivedInput): StoneDerived {
  const { lengthMm, widthMm, weightCt, wholesalePricePerCt, costPerCt } = input;

  const ratio =
    lengthMm != null && widthMm != null && widthMm !== 0 ? round2(lengthMm / widthMm) : null;

  const totalWholesalePrice =
    weightCt != null && wholesalePricePerCt != null ? round2(weightCt * wholesalePricePerCt) : null;

  const totalCost = weightCt != null && costPerCt != null ? round2(weightCt * costPerCt) : null;

  return { ratio, totalWholesalePrice, totalCost };
}
