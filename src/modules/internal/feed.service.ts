import { Prisma, prisma } from "@/db";
import { clarityRank } from "@/domain";
import type { FeedDiamond, FeedDiamondsPage } from "@/contract";

// Port of the Sherry outbound-feed Prisma read (portal /feeds/turtle.csv). The
// markup, per-vendor post-filter, CSV shaping and token auth stay in the portal
// route; only the cursor-paginated DB read moves here. `certUrl` is replaced by
// a `hasCert` boolean so the vendor host never crosses the wire (Gate §8) — the
// portal builds the same-domain cert proxy URL from the id.

const MAX_NATURAL_WEIGHT = 5.0;
const MIN_NATURAL_CLARITY_RANK = clarityRank("SI2")!;
const DEFAULT_PAGE_SIZE = 2000;

// Same where-clause the portal feed used: all available Skylab (lab) rows, plus
// Disons (natural) rows under the weight ceiling and at/above the clarity floor.
const FEED_WHERE: Prisma.DiamondWhereInput = {
  isAvailable: true,
  OR: [
    { vendor: "Skylab" },
    {
      vendor: "Disons",
      AND: [
        { OR: [{ weightCt: { lt: MAX_NATURAL_WEIGHT } }, { weightCt: null }] },
        { OR: [{ clarityRank: { gte: MIN_NATURAL_CLARITY_RANK } }, { clarityRank: null }] }
      ]
    }
  ]
};

const FEED_SELECT = {
  id: true,
  vendor: true,
  origin: true,
  shapeRaw: true,
  weightCt: true,
  colorWhite: true,
  fancyColor: true,
  fancyIntensity: true,
  fancyOvertone: true,
  clarity: true,
  cutGrade: true,
  polish: true,
  symmetry: true,
  fluorescence: true,
  lengthMm: true,
  widthMm: true,
  depthMm: true,
  depthPct: true,
  tablePct: true,
  girdle: true,
  certLab: true,
  certNumber: true,
  sku: true,
  photoUrl: true,
  videoUrl: true,
  certUrl: true,
  basePricePerCtUsd: true
} as const;

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function getFeedDiamondsPage(
  cursor: string | undefined,
  limit: number
): Promise<FeedDiamondsPage> {
  const take = Math.max(1, Math.min(5000, limit || DEFAULT_PAGE_SIZE));
  const batch = await prisma.diamond.findMany({
    where: FEED_WHERE,
    orderBy: { id: "asc" },
    take,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    select: FEED_SELECT
  });

  const rows: FeedDiamond[] = batch.map((r) => ({
    id: r.id,
    vendor: r.vendor,
    origin: r.origin,
    shapeRaw: r.shapeRaw,
    weightCt: num(r.weightCt),
    colorWhite: r.colorWhite,
    fancyColor: r.fancyColor,
    fancyIntensity: r.fancyIntensity,
    fancyOvertone: r.fancyOvertone,
    clarity: r.clarity,
    cutGrade: r.cutGrade,
    polish: r.polish,
    symmetry: r.symmetry,
    fluorescence: r.fluorescence,
    lengthMm: num(r.lengthMm),
    widthMm: num(r.widthMm),
    depthMm: num(r.depthMm),
    depthPct: num(r.depthPct),
    tablePct: num(r.tablePct),
    girdle: r.girdle,
    certLab: r.certLab,
    certNumber: r.certNumber,
    sku: r.sku,
    photoUrl: r.photoUrl,
    videoUrl: r.videoUrl,
    hasCert: Boolean(r.certUrl),
    basePricePerCtUsd: num(r.basePricePerCtUsd)
  }));

  // nextCursor is the last row's id when the page was full (more may remain).
  const nextCursor = batch.length === take ? batch[batch.length - 1].id : null;
  return { rows, nextCursor };
}
