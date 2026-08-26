import { prisma } from "@/db";
import { resolveStillImageUrl, sanitizeMediaUrl, stoneColorLabel } from "@/domain";
import type { ShareItem } from "@/contract";

function toNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function getShareItems(ids: string[]): Promise<ShareItem[]> {
  if (ids.length === 0) return [];

  const [diamonds, gemstones] = await Promise.all([
    prisma.diamond.findMany({ where: { id: { in: ids } } }),
    prisma.gemstone.findMany({ where: { id: { in: ids } } })
  ]);

  const byId = new Map<string, ShareItem>();
  for (const d of diamonds) {
    byId.set(d.id, {
      id: d.id,
      sku: d.sku,
      kind: "Diamond",
      type: d.origin === "Lab" ? "Lab Diamond" : "Natural Diamond",
      shape: d.shapeMapped ?? d.shapeRaw,
      carat: toNum(d.weightCt),
      color: stoneColorLabel(d),
      clarity: d.clarity,
      ratio: toNum(d.ratio),
      lab: d.certLab,
      certNumber: d.certNumber,
      imageUrl: resolveStillImageUrl(d.photoUrl, d.videoUrl),
      videoUrl: sanitizeMediaUrl(d.videoUrl, "video")
    });
  }
  for (const g of gemstones) {
    byId.set(g.id, {
      id: g.id,
      sku: g.sku,
      kind: "Gemstone",
      type: g.varietyRaw,
      shape: g.shapeRaw,
      carat: toNum(g.weightCt),
      color: g.colorRaw,
      clarity: null,
      ratio: toNum(g.ratio),
      lab: g.certLab,
      certNumber: g.certNumber,
      imageUrl: resolveStillImageUrl(g.imageUrl, g.videoUrl),
      videoUrl: sanitizeMediaUrl(g.videoUrl, "video")
    });
  }

  return ids.map((id) => byId.get(id)).filter((s): s is ShareItem => Boolean(s));
}
