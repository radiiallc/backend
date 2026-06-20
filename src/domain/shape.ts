type ShapeEntry = { display: string; filter: string } | null;

const DIAMOND_SHAPE_MAP: Record<string, ShapeEntry> = {
  ANCU: { display: "Old mine", filter: "Old Mine" },
  ANMQ: { display: "Antique marquise", filter: "Marquise" },
  ANOV: { display: "Antique oval", filter: "Oval" },
  AS: { display: "Asscher", filter: "Asscher" },
  BECU: { display: "Brilliant cushion", filter: "Cushion" },
  BR: { display: "Round", filter: "Round" },
  CB: { display: "Cushion", filter: "Cushion" },
  CU: { display: "Cushion", filter: "Cushion" },
  EM: { display: "Emerald", filter: "Emerald" },
  EURO: { display: "Old euro", filter: "Old euro" },
  FBZ: { display: "Febrizio", filter: "Other" },
  HM: null,
  HS: { display: "Heart", filter: "Heart" },
  KITE: { display: "Kite", filter: "Other" },
  KOV: { display: "Criss oval", filter: "Oval" },
  LSC: { display: "Lozenge", filter: "Other" },
  MOCU: { display: "Modified cushion", filter: "Cushion" },
  MORAD: { display: "Modified radiant", filter: "Radiant" },
  MOV: { display: "Moval", filter: "Moval" },
  MQ: { display: "Marquise", filter: "Marquise" },
  OCT: { display: "Octagon", filter: "Other" },
  OEB: { display: "Old euro", filter: "Old euro" },
  OHA: { display: "Octagon", filter: "Other" },
  OLMB: { display: "Old mine", filter: "Old Mine" },
  OMB: { display: "Old mine", filter: "Old Mine" },
  ONA: { display: "Octagon", filter: "Other" },
  OV: { display: "Oval", filter: "Oval" },
  PR: { display: "Princess", filter: "Princess" },
  PS: { display: "Pear", filter: "Pear" },
  RAD: { display: "Radiant", filter: "Radiant" },
  ROCU: { display: "Rose cut cushion", filter: "Cushion" },
  ROMQ: { display: "Rose cut marquise", filter: "Marquise" },
  ROPS: { display: "Rose cut pear", filter: "Pear" },
  ROV: { display: "Rose cut oval", filter: "Oval" },
  SCB: { display: "Brilliant cushion", filter: "Cushion" },
  SEM: { display: "Emerald", filter: "Emerald" },
  SM: { display: "Step marquise", filter: "Other" },
  SP: null,
  SQ: { display: "Radiant", filter: "Radiant" },
  SQANCU: { display: "Old mine", filter: "Old Mine" },
  SQMOCU: { display: "Modified cushion", filter: "Cushion" },
  TRA: null,
};

const GEMSTONE_SHAPE_MAP: Record<string, ShapeEntry> = {
  AS: { display: "Asscher", filter: "Asscher" },
  BG: { display: "Baguette", filter: "Baguette" },
  CAB: { display: "Cabochon", filter: "Cabochon" },
  CU: { display: "Cushion", filter: "Cushion" },
  EC: { display: "Emerald", filter: "Octagon" },
  EM: { display: "Emerald", filter: "Octagon" },
  HS: { display: "Heart", filter: "Heart" },
  HT: { display: "Heart", filter: "Heart" },
  MIX: { display: "Other", filter: "Other" },
  MQ: { display: "Marquise", filter: "Marquise" },
  OCT: { display: "Octagon", filter: "Octagon" },
  OTHER: { display: "Other", filter: "Other" },
  OV: { display: "Oval", filter: "Oval" },
  PR: { display: "Princess", filter: "Princess" },
  PS: { display: "Pear", filter: "Pear" },
  RAD: { display: "Radiant", filter: "Radiant" },
  RD: { display: "Round", filter: "Round" },
  TR: { display: "Trillion", filter: "Other" },
};

function lookup(
  map: Record<string, ShapeEntry>,
  raw: string | null
): ShapeEntry {
  if (!raw) return { display: "Other", filter: "Other" };
  const key = raw.trim().toUpperCase();
  if (key in map) {
    return map[key];
  }
  return { display: raw.trim(), filter: "Other" };
}

export function mapDiamondShape(raw: string | null): ShapeEntry {
  return lookup(DIAMOND_SHAPE_MAP, raw);
}

export function mapGemstoneShape(raw: string | null): ShapeEntry {
  return lookup(GEMSTONE_SHAPE_MAP, raw);
}

export function isExcludedShape(raw: string | null): boolean {
  if (!raw) return false;
  const key = raw.trim().toUpperCase();
  return key in DIAMOND_SHAPE_MAP && DIAMOND_SHAPE_MAP[key] === null;
}

export function gemstoneAbbreviationsForFilter(filterName: string): string[] {
  const target = filterName.trim().toLowerCase();
  const result: string[] = [];
  for (const [abbrev, entry] of Object.entries(GEMSTONE_SHAPE_MAP)) {
    if (entry === null) continue;
    if (entry.filter.toLowerCase() === target) {
      result.push(abbrev);
    }
  }
  return result;
}
