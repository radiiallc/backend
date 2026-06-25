// ────────────────────────────────────────────────────────────────────────────
// Document discount math (§6.7). Discounts are AMOUNTS, never percentages.
// Exact calculation order the spec mandates:
//
//   1. line_total = (unit_price × qty) − line_discount_amount   (per line)
//   2. subtotal   = Σ line_total
//   3. final_total = subtotal − document_discount_amount
//
// A line may carry an explicit `totalPrice` instead of unit×qty (e.g. a parcel
// priced as a lump); when present it's used as the pre-discount base so callers
// aren't forced to back-solve a unit price.
// ────────────────────────────────────────────────────────────────────────────

const round2 = (n: number): number => Math.round(n * 100) / 100;

export type DiscountLineInput = {
  quantity?: number | null;
  unitPrice?: number | null;
  totalPrice?: number | null;
  discountAmount?: number | null;
};

export type DocumentTotals = {
  // Per-line totals AFTER the line discount, index-aligned with the input lines.
  lineTotals: number[];
  // Σ of the pre-discount line bases (before any discount) — useful on the PDF.
  grossSubtotal: number;
  // Σ of all line-level discounts.
  lineDiscountTotal: number;
  // Σ line totals (= grossSubtotal − lineDiscountTotal).
  subtotal: number;
  // Document-level discount applied after the subtotal.
  documentDiscount: number;
  // subtotal − documentDiscount, floored at 0 (a discount never makes it go red).
  total: number;
};

// Pre-discount base for one line: explicit totalPrice wins, else unit×qty.
function lineBase(line: DiscountLineInput): number {
  if (line.totalPrice != null) return line.totalPrice;
  if (line.unitPrice != null) return line.unitPrice * (line.quantity ?? 1);
  return 0;
}

export function computeDocumentTotals(
  lines: DiscountLineInput[],
  documentDiscount?: number | null
): DocumentTotals {
  let grossSubtotal = 0;
  let lineDiscountTotal = 0;
  const lineTotals: number[] = [];

  for (const line of lines) {
    const base = lineBase(line);
    const discount = line.discountAmount ?? 0;
    grossSubtotal += base;
    lineDiscountTotal += discount;
    lineTotals.push(round2(base - discount));
  }

  const subtotal = round2(grossSubtotal - lineDiscountTotal);
  const docDiscount = documentDiscount ?? 0;
  const total = Math.max(0, round2(subtotal - docDiscount));

  return {
    lineTotals,
    grossSubtotal: round2(grossSubtotal),
    lineDiscountTotal: round2(lineDiscountTotal),
    subtotal,
    documentDiscount: round2(docDiscount),
    total
  };
}
