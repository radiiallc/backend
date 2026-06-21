// Cut, polish and symmetry are stored as the raw RapNet feed tokens (e.g. "EX",
// "ID", "VG", "G", "F", "POOR"), but the UI filters by the human-readable grade.
// This maps each canonical filter choice to every stored token that should match
// it, so a filter like "Very Good" matches the stored "VG".
//
// Ideal and Excellent are intentionally a single choice: they are the same grade
// under different lab terminology (GIA grades it "Excellent"/"EX", AGS/IGI grade
// it "Ideal"/"ID"). The "Excellent" filter therefore matches both EX and ID.
export const DIAMOND_GRADE_FILTERS = [
  "Excellent",
  "Very Good",
  "Good",
  "Fair",
  "Poor",
  "None"
] as const;

// Keyed by filter choice -> stored tokens. "Ideal" is kept as an alias of
// "Excellent" so legacy/bookmarked URLs (?cut=Ideal) still resolve. Each list
// includes the full-word forms in case a feed ever sends unabbreviated grades.
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
