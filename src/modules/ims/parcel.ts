import { Prisma } from "@/db";

// ── Parcel draw-down (Jennifer 2026-07-28 melee pilot) ───────────────────────
//
// A parcel is a lot of many tiny identical stones sold by weight, not by piece:
// 16.76 ct of 1.2mm round rubies, invoiced ~0.40 ct at a time. Unlike a single
// stone it cannot be modelled as an atomic status flip, because it leaves stock
// in slices over months.
//
// StoneDetail.weightCt / .quantity keep meaning the ORIGINAL lot (the purchase
// record, never mutated). remainingCt / remainingQty carry the running balance.
//
// Every movement goes through the DRAW / REVERSE pair below. That pairing is the
// point: an invoice draws and a void reverses; later, a partial memo out will
// draw and a memo return will reverse. Keeping one reversible primitive means
// partial memo is a caller change, not a second lifecycle to keep in sync.
//
// Rules, deliberately narrow for the pilot:
//   1. A line with no explicit caratWeight means THE WHOLE ITEM, exactly as
//      before. On a parcel "the whole item" is all REMAINING carats (not the
//      original weight — otherwise a part-drawn parcel would bill for stock that
//      is already gone).
//   2. Parcels are INVOICE-only for the pilot. Partial memo is designed for but
//      not built (Jennifer deferred it), and a half-built memo path would put
//      wrong numbers in the ledger; rejecting is the honest failure.
//   3. Over-draw, zero and negative are rejected before anything is written.

// Decimal(10,3) in the DB, so 3dp is the atom. Round every computed balance to
// it — otherwise float drift leaves a parcel at 1e-16 ct and it never closes.
const DP = 3;
const EPS = 1e-6;

export function round3(n: number): number {
  return Math.round(n * 10 ** DP) / 10 ** DP;
}

function num(value: Prisma.Decimal | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value.toString());
  return Number.isFinite(n) ? n : null;
}

type StoneBalance = {
  weightCt: Prisma.Decimal;
  quantity: number | null;
  remainingCt: Prisma.Decimal | null;
  remainingQty: number | null;
};

export type ParcelItem = {
  id: string;
  sku: string;
  itemSubtype: string | null;
  stone: StoneBalance | null;
};

export function isParcel(item: ParcelItem): boolean {
  return item.itemSubtype === "PARCEL" && item.stone !== null;
}

// What is actually in stock right now. remainingCt is null on a parcel created
// before the column existed (and on every non-parcel); fall back to the original
// lot size so an un-migrated row behaves as "nothing drawn yet" rather than
// "empty".
export function remainingOf(stone: StoneBalance): { ct: number; qty: number | null } {
  const ct = num(stone.remainingCt) ?? num(stone.weightCt) ?? 0;
  const qty = stone.remainingQty ?? stone.quantity;
  return { ct: round3(ct), qty };
}

export type DrawRequest = { caratWeight?: number | null; quantity?: number | null };

export type ResolvedDraw = {
  // Carats/pieces leaving stock on this line — what gets priced and what a
  // reverse gives back.
  drawCt: number | null;
  drawQty: number | null;
  // Balance to persist, or null to leave the balance columns alone.
  remainingAfterCt: number | null;
  remainingAfterQty: number | null;
  // True when this line decrements a balance rather than flipping the whole
  // item. A partial draw leaves the parcel IN_STOCK unless it hits zero.
  isPartial: boolean;
  // The parcel emptied out — the caller flips status to SOLD/ON_MEMO.
  emptied: boolean;
};

export type ResolveResult = { ok: true; draw: ResolvedDraw } | { ok: false; error: string };

// Validate one requested line against live stock and compute the resulting
// balance. Pure — no DB writes, so the caller can validate every line before
// opening a transaction and reject the whole document atomically.
export function resolveDraw(
  item: ParcelItem,
  requested: DrawRequest,
  docType: "MEMO_OUT" | "INVOICE"
): ResolveResult {
  const wantsPartial = requested.caratWeight != null || requested.quantity != null;
  const parcel = isParcel(item);

  if (wantsPartial && !parcel) {
    return {
      ok: false,
      error: `${item.sku}: a partial carat/piece draw is only supported on a PARCEL`
    };
  }

  // Parcels are invoice-only for the pilot. A parcel on a Memo Out needs the
  // memo to own a carat slice that is atomically returned or bought ("they
  // either return the whole memo, or buy the whole memo" — Jennifer 2026-07-28),
  // which means the return and invoice-from-memo paths both have to reverse and
  // re-draw a balance. That is deliberately not built yet, and guessing at it
  // would put wrong numbers in the ledger. Refusing is the honest failure.
  if (parcel && docType !== "INVOICE") {
    return {
      ok: false,
      error: `${item.sku} is a parcel — parcels can only go on an Invoice for now (partial Memo Out is not built yet)`
    };
  }

  // Non-parcel: keep the pre-existing atomic behaviour, untouched.
  if (!parcel) {
    return {
      ok: true,
      draw: {
        drawCt: null,
        drawQty: null,
        remainingAfterCt: null,
        remainingAfterQty: null,
        isPartial: false,
        emptied: false
      }
    };
  }

  const stock = remainingOf(item.stone!);

  if (!wantsPartial) {
    // Whole parcel invoiced at once: everything still in the lot is sold. Price
    // at REMAINING, not weightCt — a part-drawn parcel must bill for what is
    // actually there, not the original lot size.
    if (stock.ct <= 0) {
      return { ok: false, error: `${item.sku}: nothing remaining in this parcel` };
    }
    return {
      ok: true,
      draw: {
        drawCt: stock.ct,
        drawQty: stock.qty,
        remainingAfterCt: 0,
        remainingAfterQty: stock.qty === null ? null : 0,
        isPartial: false,
        emptied: true
      }
    };
  }

  // ── Partial draw ──────────────────────────────────────────────────────────
  const drawCt = requested.caratWeight == null ? null : round3(requested.caratWeight);

  if (drawCt === null) {
    return {
      ok: false,
      error: `${item.sku}: a piece count needs a carat weight alongside it (carats are what the parcel is measured in)`
    };
  }
  if (drawCt <= 0) {
    return { ok: false, error: `${item.sku}: carat weight must be greater than zero` };
  }
  if (drawCt > stock.ct + EPS) {
    return {
      ok: false,
      error: `${item.sku}: only ${stock.ct} ct remaining, cannot draw ${drawCt} ct`
    };
  }

  let drawQty: number | null = null;
  let remainingAfterQty: number | null = stock.qty;

  if (requested.quantity != null) {
    if (stock.qty === null) {
      return {
        ok: false,
        error: `${item.sku}: this parcel is tracked by carat weight only and has no piece count`
      };
    }
    drawQty = Math.round(requested.quantity);
    if (drawQty <= 0) {
      return { ok: false, error: `${item.sku}: piece count must be greater than zero` };
    }
    if (drawQty > stock.qty) {
      return {
        ok: false,
        error: `${item.sku}: only ${stock.qty} piece(s) remaining, cannot draw ${drawQty}`
      };
    }
    remainingAfterQty = stock.qty - drawQty;
  }

  // Treat a hair above zero as zero: 16.76 drawn down in 0.40s must be able to
  // close cleanly rather than stranding a rounding crumb.
  const remainingAfterCt = round3(stock.ct - drawCt);
  const emptied = remainingAfterCt <= EPS;

  return {
    ok: true,
    draw: {
      drawCt,
      drawQty,
      remainingAfterCt: emptied ? 0 : remainingAfterCt,
      // Carats are authoritative: when the last carat goes, the parcel is empty
      // even if a piece count was never supplied or has drifted.
      remainingAfterQty: emptied && remainingAfterQty !== null ? 0 : remainingAfterQty,
      isPartial: true,
      emptied
    }
  };
}

// Opening balance for a newly created stone. A parcel starts entirely
// remaining; a single or pair gets nulls (it is atomic, not drawn down). Spread
// into the StoneDetail create so every path that mints inventory — manual add,
// inbound Bill In / Memo In, CSV import — initialises the balance identically.
export function parcelOpeningBalance(
  itemSubtype: string | null | undefined,
  stone: { weightCt: number; quantity?: number | null }
): { remainingCt?: number; remainingQty?: number | null } {
  if (itemSubtype !== "PARCEL") return {};
  return { remainingCt: round3(stone.weightCt), remainingQty: stone.quantity ?? null };
}

// A weight correction on a parcel that has not been drawn yet should carry the
// balance with it — during a 100-SKU import week a mistyped carat weight gets
// fixed before anything sells, and leaving the balance behind would strand the
// parcel at the wrong size. Once ANY carats have gone out, the balance is a
// ledger position and an edit to the lot size must not silently reset it.
export function rebaseUntouchedParcel(
  itemSubtype: string | null | undefined,
  existing: StoneBalance,
  nextWeightCt: number | null,
  nextQuantity: number | null | undefined
): { remainingCt?: number; remainingQty?: number | null } {
  if (itemSubtype !== "PARCEL" || nextWeightCt === null) return {};
  const current = remainingOf(existing);
  const originalCt = round3(num(existing.weightCt) ?? 0);
  if (Math.abs(current.ct - originalCt) > EPS) return {}; // already drawn — leave it
  const out: { remainingCt?: number; remainingQty?: number | null } = {
    remainingCt: round3(nextWeightCt)
  };
  if (nextQuantity !== undefined && existing.remainingQty === existing.quantity) {
    out.remainingQty = nextQuantity;
  }
  return out;
}

// Physical recount / write-off of a parcel balance. Melee does not divide
// evenly: a lot sold down in 0.40 ct slices strands a 0.02 ct crumb that will
// never be invoiced, and without this the parcel sits open forever. Also covers
// the honest opposite — a recount finding more than the books say.
//
// Distinct from a draw: no document, no revenue, and a reason is mandatory,
// because "stock changed and no money moved" is exactly the event an auditor
// asks about.
export type AdjustResult =
  | { ok: true; remainingCt: number; remainingQty: number | null; emptied: boolean }
  | { ok: false; error: string };

export function resolveAdjust(
  item: ParcelItem,
  next: { remainingCt: number; remainingQty?: number | null }
): AdjustResult {
  if (!isParcel(item)) {
    return { ok: false, error: `${item.sku} is not a parcel — there is no balance to adjust` };
  }
  if (!Number.isFinite(next.remainingCt) || next.remainingCt < 0) {
    return { ok: false, error: "Remaining carat weight cannot be negative" };
  }

  const remainingCt = round3(next.remainingCt);
  const stock = remainingOf(item.stone!);

  let remainingQty: number | null = stock.qty;
  if (next.remainingQty !== undefined && next.remainingQty !== null) {
    if (!Number.isInteger(next.remainingQty) || next.remainingQty < 0) {
      return { ok: false, error: "Remaining piece count cannot be negative" };
    }
    remainingQty = next.remainingQty;
  }

  const emptied = remainingCt <= EPS;
  return {
    ok: true,
    remainingCt: emptied ? 0 : remainingCt,
    remainingQty: emptied && remainingQty !== null ? 0 : remainingQty,
    emptied
  };
}

// The REVERSE half of the pair: give drawn stock back. Used by void (undo an
// invoice) and, once partial memo lands, by the memo return path. Returns the
// restored balance so the caller can decide the item's status.
export function reverseDraw(
  stone: StoneBalance,
  drawCt: number | null,
  drawQty: number | null
): { remainingCt: number; remainingQty: number | null } {
  const current = remainingOf(stone);
  const restoredCt = round3(current.ct + (drawCt ?? 0));
  const restoredQty =
    current.qty === null && drawQty === null ? null : (current.qty ?? 0) + (drawQty ?? 0);
  return { remainingCt: restoredCt, remainingQty: restoredQty };
}
