import type { ResolveResult } from "./parcel";

/**
 * Piece-level draw-down for jewelry, the sibling of the parcel carat draw-down.
 *
 * A brand stocks 16 of the same hoop on one line. Sending 3 out must leave 13 in
 * stock, so `quantity` stays the ORIGINAL lot size and `remainingQty` carries the
 * running balance — exactly the split `weightCt`/`remainingCt` uses on a parcel.
 * Pieces are whole and fungible here, so there is no carat axis and no epsilon:
 * integers throughout.
 *
 * Three paths, and pieces are conserved across all of them:
 *   Memo Out DRAWS      — a partial draw leaves the lot IN_STOCK
 *   Return   REVERSES   — the pieces come back
 *   Invoice  SETTLES    — prices the memo'd pieces and writes NO balance
 *
 * A null `remainingQty` reads as untouched (falls back to `quantity`) so rows
 * written before the balance column existed behave.
 */

type JewelryBalance = {
  quantity: number;
  remainingQty: number | null;
};

export type JewelryItem = {
  id: string;
  sku: string;
  itemType: string | null;
  jewelry: JewelryBalance | null;
};

export function isJewelryLot(item: JewelryItem): boolean {
  return item.itemType === "JEWELRY" && item.jewelry !== null;
}

export function remainingPieces(jewelry: JewelryBalance): number {
  return jewelry.remainingQty ?? jewelry.quantity;
}

export type JewelryDrawRequest = { quantity?: number | null };

export function resolveJewelryDraw(item: JewelryItem, requested: JewelryDrawRequest): ResolveResult {
  const stock = remainingPieces(item.jewelry!);

  if (requested.quantity == null) {
    if (stock <= 0) {
      return { ok: false, error: `${item.sku}: no pieces remaining on this line` };
    }
    return {
      ok: true,
      draw: {
        drawCt: null,
        drawQty: stock,
        remainingAfterCt: null,
        remainingAfterQty: 0,
        isPartial: false,
        emptied: true,
        lot: "JEWELRY"
      }
    };
  }

  const drawQty = Math.round(requested.quantity);
  if (drawQty <= 0) {
    return { ok: false, error: `${item.sku}: piece count must be greater than zero` };
  }
  if (drawQty > stock) {
    return {
      ok: false,
      error: `${item.sku}: only ${stock} piece(s) remaining, cannot send ${drawQty}`
    };
  }

  const remainingAfterQty = stock - drawQty;
  const emptied = remainingAfterQty <= 0;

  return {
    ok: true,
    draw: {
      drawCt: null,
      drawQty,
      remainingAfterCt: null,
      remainingAfterQty,
      isPartial: true,
      emptied,
      lot: "JEWELRY"
    }
  };
}

export type JewelryMemoDraw = { quantity: number | null };

/**
 * Absent quantity means "settle whatever is out on the memo" — reading it as a
 * fresh draw would invoice pieces already sitting at the client AND take more off
 * the balance. A different quantity is a real draw against what is still in the
 * safe: the pieces are identical, so the client keeping 3 on memo while buying 2
 * more is coherent, and the memo stays open for its own 3.
 */
export function matchesJewelryMemoSlice(
  memo: JewelryMemoDraw,
  requested: JewelryDrawRequest
): boolean {
  if (requested.quantity == null) return true;
  if (memo.quantity === null) return false;
  return Math.round(requested.quantity) === memo.quantity;
}

export function resolveJewelrySettle(item: JewelryItem, memo: JewelryMemoDraw): ResolveResult {
  const stock = remainingPieces(item.jewelry!);
  return {
    ok: true,
    draw: {
      drawCt: null,
      drawQty: memo.quantity,
      remainingAfterCt: null,
      remainingAfterQty: null,
      isPartial: stock > 0,
      emptied: stock <= 0,
      lot: "JEWELRY"
    }
  };
}

export function reverseJewelryDraw(jewelry: JewelryBalance, drawQty: number | null): number {
  return remainingPieces(jewelry) + (drawQty ?? 0);
}

export function jewelryOpeningBalance(quantity: number | null | undefined): number {
  return quantity ?? 1;
}
