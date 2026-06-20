import { Prisma, prisma } from "@/db";
import {
  gemstoneOriginDisplay,
  gemstoneVarietyDisplay,
  mapGemstoneShape,
  resolveStillImageUrl,
  sanitizeMediaUrl
} from "@/domain";
import type {
  DiamondDetail,
  DiamondOrigin,
  GemstoneDetail,
  InventoryCounts
} from "@/contract";

function toNumber(value: Prisma.Decimal | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function getInventoryCounts(): Promise<InventoryCounts> {
  try {
    const [natural, lab, gemstones] = await Promise.all([
      prisma.diamond.count({ where: { isAvailable: true, origin: "Natural" } }),
      prisma.diamond.count({ where: { isAvailable: true, origin: "Lab" } }),
      prisma.gemstone.count({ where: { isAvailable: true } })
    ]);
    return { natural, lab, gemstones };
  } catch (error) {
    console.error("getInventoryCounts failed", error);
    return { natural: 0, lab: 0, gemstones: 0 };
  }
}

export async function getDiamondByIdForBuyer(
  id: string,
  companyId: string | null
): Promise<DiamondDetail | null> {
  const diamond = await prisma.diamond.findUnique({ where: { id } });
  if (!diamond) return null;

  const origin = diamond.origin as DiamondOrigin;

  let markupPct = 0;
  if (companyId) {
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { labDiamondMarkupPct: true, naturalDiamondMarkupPct: true }
    });
    const raw =
      origin === "Lab" ? company?.labDiamondMarkupPct : company?.naturalDiamondMarkupPct;
    markupPct = Number(raw ?? 0);
    if (!Number.isFinite(markupPct)) markupPct = 0;
  }
  const factor = 1 + markupPct / 100;

  const base = toNumber(diamond.basePriceUsd);
  const basePerCt = toNumber(diamond.basePricePerCtUsd);

  return {
    id: diamond.id,
    sku: diamond.sku,
    origin,
    shapeRaw: diamond.shapeRaw,
    shapeMapped: diamond.shapeMapped,
    weightCt: toNumber(diamond.weightCt),
    colorWhite: diamond.colorWhite,
    fancyColor: diamond.fancyColor,
    clarity: diamond.clarity,
    cutGrade: diamond.cutGrade,
    polish: diamond.polish,
    symmetry: diamond.symmetry,
    fluorescence: diamond.fluorescence,
    lengthMm: toNumber(diamond.lengthMm),
    widthMm: toNumber(diamond.widthMm),
    depthMm: toNumber(diamond.depthMm),
    ratio: toNumber(diamond.ratio),
    depthPct: toNumber(diamond.depthPct),
    tablePct: toNumber(diamond.tablePct),
    certLab: diamond.certLab,
    certNumber: diamond.certNumber,
    certUrl: diamond.certUrl,
    treatment: diamond.treatment,
    growthMethod: diamond.growthMethod,
    displayPriceUsd: base === null ? null : Math.round(base * factor * 100) / 100,
    displayPricePerCtUsd:
      basePerCt === null ? null : Math.round(basePerCt * factor * 100) / 100,
    videoUrl: sanitizeMediaUrl(diamond.videoUrl, "video"),
    photoUrl: resolveStillImageUrl(diamond.photoUrl, diamond.videoUrl),
    isAvailable: diamond.isAvailable
  };
}

export async function getGemstoneByIdForBuyer(
  id: string,
  companyId: string | null
): Promise<GemstoneDetail | null> {
  const gem = await prisma.gemstone.findUnique({ where: { id } });
  if (!gem) return null;

  let markupPct = 0;
  if (companyId) {
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { gemstoneMarkupPct: true }
    });
    markupPct = Number(company?.gemstoneMarkupPct ?? 0);
    if (!Number.isFinite(markupPct)) markupPct = 0;
  }
  const factor = 1 + markupPct / 100;

  const base = toNumber(gem.basePriceUsd);
  const basePerCt = toNumber(gem.basePricePerCtUsd);

  return {
    id: gem.id,
    sku: gem.sku,
    varietyRaw: gem.varietyRaw,
    varietyMapped: gemstoneVarietyDisplay(gem.varietyRaw),
    shapeRaw: gem.shapeRaw,
    shapeMapped: mapGemstoneShape(gem.shapeRaw)?.display ?? gem.shapeRaw,
    colorRaw: gem.colorRaw,
    weightCt: toNumber(gem.weightCt),
    lengthMm: toNumber(gem.lengthMm),
    widthMm: toNumber(gem.widthMm),
    depthMm: toNumber(gem.depthMm),
    ratio: toNumber(gem.ratio),
    displayPriceUsd: base === null ? null : Math.round(base * factor * 100) / 100,
    displayPricePerCtUsd:
      basePerCt === null ? null : Math.round(basePerCt * factor * 100) / 100,
    certLab: gem.certLab,
    certNumber: gem.certNumber,
    certUrl: gem.certUrl,
    imageUrl: resolveStillImageUrl(gem.imageUrl, gem.videoUrl),
    image2Url: gem.image2Url,
    image3Url: gem.image3Url,
    image4Url: gem.image4Url,
    videoUrl: sanitizeMediaUrl(gem.videoUrl, "video"),
    origin: gemstoneOriginDisplay(gem.origin),
    treatment: gem.treatment,
    isAvailable: gem.isAvailable
  };
}
