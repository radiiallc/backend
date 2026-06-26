type VarietyEntry = { display: string; filter: string };

export const GEMSTONE_VARIETY_FILTERS = [
  "Sapphire",
  "Ruby",
  "Emerald",
  "Spinel",
  "Garnet",
  "Beryl",
  "Morganite",
  "Peridot",
  "Aquamarine"
] as const;

const GEMSTONE_VARIETY_MAP: Record<string, VarietyEntry> = {
  SAP: { display: "Sapphire", filter: "Sapphire" },
  RUB: { display: "Ruby", filter: "Ruby" },
  EME: { display: "Emerald", filter: "Emerald" },
  SPN: { display: "Spinel", filter: "Spinel" },
  GAR: { display: "Garnet", filter: "Garnet" },
  BRL: { display: "Beryl", filter: "Beryl" },
  AQUA: { display: "Aquamarine", filter: "Aquamarine" },
  PRD: { display: "Peridot", filter: "Peridot" },
  MGT: { display: "Morganite", filter: "Morganite" },
  SAPPHIRE: { display: "Sapphire", filter: "Sapphire" },
  RUBY: { display: "Ruby", filter: "Ruby" },
  EMERALD: { display: "Emerald", filter: "Emerald" },
  SPINEL: { display: "Spinel", filter: "Spinel" },
  GARNET: { display: "Garnet", filter: "Garnet" },
  BERYL: { display: "Beryl", filter: "Beryl" },
  AQUAMARINE: { display: "Aquamarine", filter: "Aquamarine" },
  PERIDOT: { display: "Peridot", filter: "Peridot" },
  MORGANITE: { display: "Morganite", filter: "Morganite" }
};

export function mapGemstoneVariety(raw: string | null): VarietyEntry {
  if (!raw) return { display: "Gemstone", filter: "Other" };
  const key = raw.trim().toUpperCase();
  if (key in GEMSTONE_VARIETY_MAP) return GEMSTONE_VARIETY_MAP[key];
  return { display: raw.trim(), filter: "Other" };
}

export function gemstoneVarietyDisplay(raw: string | null): string | null {
  if (!raw || !raw.trim()) return null;
  return mapGemstoneVariety(raw).display;
}

const VARIETY_ABBREV: Record<string, string> = {
  Sapphire: "SAP",
  Ruby: "RUB",
  Emerald: "EME",
  Spinel: "SPN",
  Garnet: "GAR",
  Beryl: "BRL",
  Aquamarine: "AQUA",
  Peridot: "PRD",
  Morganite: "MGT"
};

export function gemstoneVarietyAbbrev(raw: string | null): string | null {
  if (!raw || !raw.trim()) return null;
  const key = raw.trim().toUpperCase();
  if (key in GEMSTONE_VARIETY_MAP) {
    return VARIETY_ABBREV[GEMSTONE_VARIETY_MAP[key].display] ?? key;
  }
  return key;
}

export function gemstoneOriginDisplay(raw: string | null): string | null {
  if (!raw || !raw.trim()) return null;
  return raw.trim();
}

export function gemstoneVarietyTokensForFilter(filterName: string): string[] {
  const target = filterName.trim().toLowerCase();
  const tokens: string[] = [];
  for (const [token, entry] of Object.entries(GEMSTONE_VARIETY_MAP)) {
    if (entry.filter.toLowerCase() === target) tokens.push(token);
  }
  return tokens;
}
