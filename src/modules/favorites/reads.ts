import { Prisma, prisma } from "@/db";
import {
  gemstoneVarietyDisplay,
  mapGemstoneShape,
  resolveStillImageUrl,
  sanitizeMediaUrl,
  stoneColorLabel
} from "@/domain";
import type { FavoriteLine } from "@/contract";

function toNumber(value: Prisma.Decimal | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function getFavoriteCountForUser(userId: string): Promise<number> {
  return prisma.favorite.count({ where: { userId } });
}

export async function getFavoriteGemstoneIdsForUser(userId: string): Promise<string[]> {
  const rows = await prisma.favorite.findMany({
    where: { userId },
    select: { gemstoneId: true, diamondId: true }
  });
  return rows
    .map((r) => r.gemstoneId ?? r.diamondId)
    .filter((id): id is string => Boolean(id));
}

function pct(value: Prisma.Decimal | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function applyMarkup(base: number | null, factor: number): number | null {
  return base === null ? null : Math.round(base * factor * 100) / 100;
}

export async function getFavoritesForBuyer(
  userId: string,
  companyId: string | null
): Promise<FavoriteLine[]> {
  const company = companyId
    ? await prisma.company.findUnique({
        where: { id: companyId },
        select: {
          gemstoneMarkupPct: true,
          labDiamondMarkupPct: true,
          naturalDiamondMarkupPct: true
        }
      })
    : null;
  const gemFactor = 1 + pct(company?.gemstoneMarkupPct) / 100;
  const labFactor = 1 + pct(company?.labDiamondMarkupPct) / 100;
  const naturalFactor = 1 + pct(company?.naturalDiamondMarkupPct) / 100;

  const rows = await prisma.favorite.findMany({
    where: { userId },
    orderBy: { addedAt: "desc" },
    include: { gemstone: true, diamond: true }
  });

  const lines: FavoriteLine[] = [];
  for (const fav of rows) {
    if (fav.gemstone) {
      const g = fav.gemstone;
      lines.push({
        favoriteId: fav.id,
        gemstoneId: g.id,
        sku: g.sku,
        varietyRaw: gemstoneVarietyDisplay(g.varietyRaw),
        shapeRaw: g.shapeRaw,
        shapeMapped: mapGemstoneShape(g.shapeRaw)?.display ?? g.shapeRaw,
        colorRaw: g.colorRaw,
        weightCt: toNumber(g.weightCt),
        displayPriceUsd: applyMarkup(toNumber(g.basePriceUsd), gemFactor),
        displayPricePerCtUsd: applyMarkup(toNumber(g.basePricePerCtUsd), gemFactor),
        isAvailable: g.isAvailable,
        imageUrl: resolveStillImageUrl(g.imageUrl, g.videoUrl),
        videoUrl: sanitizeMediaUrl(g.videoUrl, "video"),
        addedAt: fav.addedAt.toISOString()
      });
    } else if (fav.diamond) {
      const d = fav.diamond;
      const factor = d.origin === "Lab" ? labFactor : naturalFactor;
      lines.push({
        favoriteId: fav.id,
        gemstoneId: d.id,
        sku: d.sku,
        varietyRaw: d.origin === "Lab" ? "Lab Diamond" : "Natural Diamond",
        shapeRaw: d.shapeRaw,
        shapeMapped: d.shapeMapped ?? d.shapeRaw,
        colorRaw: stoneColorLabel(d),
        weightCt: toNumber(d.weightCt),
        displayPriceUsd: applyMarkup(toNumber(d.basePriceUsd), factor),
        displayPricePerCtUsd: applyMarkup(toNumber(d.basePricePerCtUsd), factor),
        isAvailable: d.isAvailable,
        imageUrl: resolveStillImageUrl(d.photoUrl, d.videoUrl),
        videoUrl: sanitizeMediaUrl(d.videoUrl, "video"),
        addedAt: fav.addedAt.toISOString()
      });
    }
  }
  return lines;
}
