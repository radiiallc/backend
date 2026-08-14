export const DIAMOND_GRADE_FILTERS = [
  "Excellent",
  "Very Good",
  "Good",
  "Fair",
  "Poor",
  "None"
] as const;

const DIAMOND_GRADE_TOKENS: Record<string, string[]> = {
  Excellent: ["EX", "ID", "Excellent", "Ideal"],
  Ideal: ["EX", "ID", "Excellent", "Ideal"],
  "Very Good": ["VG", "Very Good"],
  Good: ["G", "GD", "GOOD", "Good"],
  Fair: ["F", "FR", "Fair"],
  Poor: ["P", "PR", "POOR", "Poor"],
  None: ["N", "NONE", "None"]
};

export function diamondGradeTokensForFilter(filterName: string): string[] {
  const target = filterName.trim().toLowerCase();
  for (const [name, tokens] of Object.entries(DIAMOND_GRADE_TOKENS)) {
    if (name.toLowerCase() === target) return tokens;
  }
  return [];
}
