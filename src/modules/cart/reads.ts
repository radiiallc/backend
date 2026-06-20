import { Prisma, prisma } from "@/db";
import { gemstoneVarietyDisplay, mapGemstoneShape, resolveStillImageUrl } from "@/domain";
import type { BuyerCart, CartLine } from "@/contract";

function toNumber(value: Prisma.Decimal | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function getCartItemCountForUser(userId: string): Promise<number> {
  const cart = await prisma.cart.findUnique({
    where: { userId },
    select: { items: { select: { qty: true } } }
  });
  if (!cart) return 0;
  return cart.items.reduce((sum, it) => sum + (it.qty ?? 0), 0);
}

export async function getCartForBuyer(
  userId: string,
  companyId: string | null
): Promise<BuyerCart> {
  let gemMarkupPct = 0;
  let labMarkupPct = 0;
  let naturalMarkupPct = 0;
  if (companyId) {
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: {
        gemstoneMarkupPct: true,
        labDiamondMarkupPct: true,
        naturalDiamondMarkupPct: true
      }
    });
    gemMarkupPct = Number(company?.gemstoneMarkupPct ?? 0);
    labMarkupPct = Number(company?.labDiamondMarkupPct ?? 0);
    naturalMarkupPct = Number(company?.naturalDiamondMarkupPct ?? 0);
    if (!Number.isFinite(gemMarkupPct)) gemMarkupPct = 0;
    if (!Number.isFinite(labMarkupPct)) labMarkupPct = 0;
    if (!Number.isFinite(naturalMarkupPct)) naturalMarkupPct = 0;
  }
  const gemFactor = 1 + gemMarkupPct / 100;
  const labFactor = 1 + labMarkupPct / 100;
  const naturalFactor = 1 + naturalMarkupPct / 100;

  const cart = await prisma.cart.findUnique({
    where: { userId },
    include: {
      items: {
        orderBy: { addedAt: "desc" },
        include: { gemstone: true, diamond: true }
      }
    }
  });

  if (!cart) {
    return { cartId: null, items: [], subtotalUsd: 0 };
  }

  let subtotal = 0;
  const items: CartLine[] = [];
  for (const ci of cart.items) {
    let line: CartLine | null = null;

    if (ci.gemstone) {
      const gem = ci.gemstone;
      const base = toNumber(gem.basePriceUsd);
      const basePerCt = toNumber(gem.basePricePerCtUsd);
      const display = base === null ? null : Math.round(base * gemFactor * 100) / 100;
      const displayPerCt =
        basePerCt === null ? null : Math.round(basePerCt * gemFactor * 100) / 100;
      const lineTotal = display === null ? null : Math.round(display * ci.qty * 100) / 100;
      line = {
        cartItemId: ci.id,
        itemId: gem.id,
        kind: "gemstone",
        gemstoneId: gem.id,
        diamondId: null,
        sku: gem.sku,
        varietyRaw: gemstoneVarietyDisplay(gem.varietyRaw),
        shapeRaw: gem.shapeRaw,
        shapeMapped: mapGemstoneShape(gem.shapeRaw)?.display ?? gem.shapeRaw,
        colorRaw: gem.colorRaw,
        weightCt: toNumber(gem.weightCt),
        qty: ci.qty,
        displayPriceUsd: display,
        displayPricePerCtUsd: displayPerCt,
        lineTotalUsd: lineTotal,
        isAvailable: gem.isAvailable,
        imageUrl: resolveStillImageUrl(gem.imageUrl, gem.videoUrl)
      };
    } else if (ci.diamond) {
      const dia = ci.diamond;
      const factor = dia.origin === "Lab" ? labFactor : naturalFactor;
      const base = toNumber(dia.basePriceUsd);
      const basePerCt = toNumber(dia.basePricePerCtUsd);
      const display = base === null ? null : Math.round(base * factor * 100) / 100;
      const displayPerCt =
        basePerCt === null ? null : Math.round(basePerCt * factor * 100) / 100;
      const lineTotal = display === null ? null : Math.round(display * ci.qty * 100) / 100;
      line = {
        cartItemId: ci.id,
        itemId: dia.id,
        kind: "diamond",
        gemstoneId: null,
        diamondId: dia.id,
        sku: dia.sku,
        varietyRaw: dia.origin === "Lab" ? "Lab Diamond" : "Natural Diamond",
        shapeRaw: dia.shapeRaw,
        shapeMapped: dia.shapeMapped ?? dia.shapeRaw,
        colorRaw: dia.fancyColor ?? dia.colorWhite,
        weightCt: toNumber(dia.weightCt),
        qty: ci.qty,
        displayPriceUsd: display,
        displayPricePerCtUsd: displayPerCt,
        lineTotalUsd: lineTotal,
        isAvailable: dia.isAvailable,
        imageUrl: resolveStillImageUrl(dia.photoUrl, dia.videoUrl)
      };
    }

    if (!line) continue;
    if (line.lineTotalUsd !== null) subtotal += line.lineTotalUsd;
    items.push(line);
  }

  return {
    cartId: cart.id,
    items,
    subtotalUsd: Math.round(subtotal * 100) / 100
  };
}
