import { Prisma } from "@/db";

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

export function remainingOf(stone: StoneBalance): { ct: number; qty: number | null } {
  const ct = num(stone.remainingCt) ?? num(stone.weightCt) ?? 0;
  const qty = stone.remainingQty ?? stone.quantity;
  return { ct: round3(ct), qty };
}

export type DrawRequest = { caratWeight?: number | null; quantity?: number | null };

export type ResolvedDraw = {
  drawCt: number | null;
  drawQty: number | null;
  remainingAfterCt: number | null;
  remainingAfterQty: number | null;
  isPartial: boolean;
  emptied: boolean;
  /** Which balance the caller must write: a parcel's carats, a jewelry line's
   *  pieces, or null for an atomic item that has no balance to keep. */
  lot: "PARCEL" | "JEWELRY" | null;
};

export type ResolveResult = { ok: true; draw: ResolvedDraw } | { ok: false; error: string };

export function resolveDraw(item: ParcelItem, requested: DrawRequest): ResolveResult {
  const wantsPartial = requested.caratWeight != null || requested.quantity != null;
  const parcel = isParcel(item);

  if (wantsPartial && !parcel) {
    return {
      ok: false,
      error: `${item.sku}: a partial carat/piece draw is only supported on a PARCEL`
    };
  }

  if (!parcel) {
    return {
      ok: true,
      draw: {
        drawCt: null,
        drawQty: null,
        remainingAfterCt: null,
        remainingAfterQty: null,
        isPartial: false,
        emptied: false,
        lot: null
      }
    };
  }

  const stock = remainingOf(item.stone!);

  if (!wantsPartial) {
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
        emptied: true,
        lot: "PARCEL"
      }
    };
  }

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

  const remainingAfterCt = round3(stock.ct - drawCt);
  const emptied = remainingAfterCt <= EPS;

  return {
    ok: true,
    draw: {
      drawCt,
      drawQty,
      remainingAfterCt: emptied ? 0 : remainingAfterCt,
      remainingAfterQty: emptied && remainingAfterQty !== null ? 0 : remainingAfterQty,
      isPartial: true,
      emptied,
      lot: "PARCEL"
    }
  };
}

export type MemoDraw = { caratWeight: number | null; quantity: number | null };

export function matchesMemoSlice(memo: MemoDraw, requested: DrawRequest): boolean {
  if (requested.caratWeight == null) return true;
  if (memo.caratWeight === null) return false;
  return Math.abs(round3(requested.caratWeight) - round3(memo.caratWeight)) <= EPS;
}

export function resolveSettle(item: ParcelItem, memo: MemoDraw, requested: DrawRequest): ResolveResult {
  const stock = remainingOf(item.stone!);
  const memoCt = memo.caratWeight === null ? null : round3(memo.caratWeight);

  if (
    requested.quantity != null &&
    memo.quantity !== null &&
    Math.round(requested.quantity) !== memo.quantity
  ) {
    return {
      ok: false,
      error: `${item.sku}: ${memoCt} ct out on memo to this client is ${memo.quantity} piece(s), not ${Math.round(requested.quantity)} — invoice the whole memo'd slice, or record a return first`
    };
  }

  return {
    ok: true,
    draw: {
      drawCt: memoCt,
      drawQty: memo.quantity,
      remainingAfterCt: null,
      remainingAfterQty: null,
      isPartial: stock.ct > EPS,
      emptied: stock.ct <= EPS,
      lot: "PARCEL"
    }
  };
}

export function parcelOpeningBalance(
  itemSubtype: string | null | undefined,
  stone: { weightCt: number; quantity?: number | null }
): { remainingCt?: number; remainingQty?: number | null } {
  if (itemSubtype !== "PARCEL") return {};
  return { remainingCt: round3(stone.weightCt), remainingQty: stone.quantity ?? null };
}

export function rebaseUntouchedParcel(
  itemSubtype: string | null | undefined,
  existing: StoneBalance,
  nextWeightCt: number | null,
  nextQuantity: number | null | undefined
): { remainingCt?: number; remainingQty?: number | null } {
  if (itemSubtype !== "PARCEL" || nextWeightCt === null) return {};
  const current = remainingOf(existing);
  const originalCt = round3(num(existing.weightCt) ?? 0);
  if (Math.abs(current.ct - originalCt) > EPS) return {};
  const out: { remainingCt?: number; remainingQty?: number | null } = {
    remainingCt: round3(nextWeightCt)
  };
  if (nextQuantity !== undefined && existing.remainingQty === existing.quantity) {
    out.remainingQty = nextQuantity;
  }
  return out;
}

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
