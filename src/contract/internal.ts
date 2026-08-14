
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
