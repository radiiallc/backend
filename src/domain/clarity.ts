export const CLARITY_ORDER = [
  "FL",
  "IF",
  "VVS1",
  "VVS2",
  "VS1",
  "VS2",
  "SI1",
  "SI2",
  "I1",
  "I2",
  "I3"
] as const;

export type ClarityGrade = (typeof CLARITY_ORDER)[number];

export function clarityRank(value: string | null | undefined): number | null {
  if (!value) return null;
  const index = CLARITY_ORDER.indexOf(value.trim().toUpperCase() as ClarityGrade);
  return index === -1 ? null : CLARITY_ORDER.length - index;
}
