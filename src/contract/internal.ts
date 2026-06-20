// Internal (service-to-service) wire types for the secret-gated /internal API
// surface. These back the portal's public/feed/proxy routes (share page, Sherry
// CSV feed, cert proxy, keep-warm) that have no buyer session — the portal calls
// them server-side with the shared INTERNAL_API_SECRET. They deliberately never
// expose vendor `certUrl` (Gate §8): the cert proxy streams the file, and feed
// rows carry a `hasCert` boolean instead of the URL.

// One stone for the public /share selection page (resolved media, no prices —
// share prices come from the URL token, not the DB; no certUrl).
export type ShareItem = {
  id: string;
  sku: string;
  kind: "Diamond" | "Gemstone";
  type: string | null;
  shape: string | null;
  carat: number | null;
  color: string | null;
  clarity: string | null;
  ratio: number | null;
  lab: string | null;
  certNumber: string | null;
  imageUrl: string | null;
  videoUrl: string | null;
};

// One diamond row for the Sherry outbound CSV feed. Mirrors the feed's prior
// Prisma select, but `certUrl` is replaced by `hasCert` — the portal builds the
// same-domain cert proxy URL from `id` when `hasCert` is true.
export type FeedDiamond = {
  id: string;
  vendor: string;
  origin: string;
  shapeRaw: string | null;
  weightCt: number | null;
  colorWhite: string | null;
  fancyColor: string | null;
  fancyIntensity: string | null;
  fancyOvertone: string | null;
  clarity: string | null;
  cutGrade: string | null;
  polish: string | null;
  symmetry: string | null;
  fluorescence: string | null;
  lengthMm: number | null;
  widthMm: number | null;
  depthMm: number | null;
  depthPct: number | null;
  tablePct: number | null;
  girdle: string | null;
  certLab: string | null;
  certNumber: string | null;
  sku: string;
  photoUrl: string | null;
  videoUrl: string | null;
  hasCert: boolean;
  basePricePerCtUsd: number | null;
};

export type FeedDiamondsPage = {
  rows: FeedDiamond[];
  nextCursor: string | null;
};
