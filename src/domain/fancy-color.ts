/**
 * Fancy-colour diamonds are graded on two axes: the hue itself and how strongly
 * it shows. A stone is "Fancy Vivid Yellow", never just "Yellow" — quoting the
 * hue without the intensity loses most of what the price is based on.
 *
 * Both lists are ordered the way the trade reads them (KAN-55), strongest
 * intensity first, so pickers must render them as-is and not alphabetise.
 */

export const FANCY_HUES = [
  "Yellow",
  "Orange",
  "Pink",
  "Blue",
  "Green",
  "Brown",
  "Grey",
  "Red",
  "White"
] as const;

export const FANCY_INTENSITIES = [
  "Fancy Deep",
  "Fancy Dark",
  "Fancy Vivid",
  "Fancy Intense",
  "Fancy",
  "Fancy Light",
  "Light",
  "Very Light"
] as const;

export type FancyHue = (typeof FANCY_HUES)[number];
export type FancyIntensity = (typeof FANCY_INTENSITIES)[number];

function canon(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

/** Matches a hue or intensity case-insensitively, returning the canonical spelling. */
function match<T extends string>(list: readonly T[], value: string): T | null {
  const v = canon(value).toLowerCase();
  return list.find((o) => o.toLowerCase() === v) ?? null;
}

export function isFancyHue(value: string | null | undefined): boolean {
  return match(FANCY_HUES, value ?? "") !== null;
}

export function isFancyIntensity(value: string | null | undefined): boolean {
  return match(FANCY_INTENSITIES, value ?? "") !== null;
}

/**
 * How a colour reads on a document or a list: the fancy pair when the stone has
 * one, otherwise the white grade. Falls back to whichever half exists so a
 * half-filled record still says something.
 */
export function stoneColorLabel(stone: {
  color?: string | null;
  colorWhite?: string | null;
  fancyColor?: string | null;
  fancyIntensity?: string | null;
}): string | null {
  const hue = canon(stone.fancyColor);
  const white = canon(stone.color ?? stone.colorWhite);
  if (!hue) return white || null;
  const intensity = canon(stone.fancyIntensity);
  // "Fancy" on its own is already the intensity, so "Fancy Yellow" is complete.
  return intensity ? `${intensity} ${hue}` : hue;
}

/**
 * Splits a written colour — "Fancy Vivid Yellow", "fancy yellow", "G" — into the
 * two graded halves. Vendor sheets and cert lookups hand us one string; anything
 * that is not a recognised fancy pair is treated as a white grade so nothing is
 * silently reclassified.
 */
export function parseFancyColor(raw: string | null | undefined): {
  color: string | null;
  fancyColor: string | null;
  fancyIntensity: string | null;
} {
  const v = canon(raw);
  if (!v) return { color: null, fancyColor: null, fancyIntensity: null };

  const hueOnly = match(FANCY_HUES, v);
  if (hueOnly) return { color: null, fancyColor: hueOnly, fancyIntensity: null };

  // Longest intensity first: "Fancy Light" must win over "Fancy".
  const byLength = [...FANCY_INTENSITIES].sort((a, b) => b.length - a.length);
  for (const intensity of byLength) {
    const prefix = intensity.toLowerCase() + " ";
    if (!v.toLowerCase().startsWith(prefix)) continue;
    const rest = v.slice(intensity.length + 1);
    const hue = match(FANCY_HUES, rest);
    // An unrecognised remainder ("Fancy Yellow-Green") keeps its full text as the
    // hue — better a faithful record than a dropped modifier.
    return { color: null, fancyColor: hue ?? canon(rest), fancyIntensity: intensity };
  }

  if (/^fancy\b/i.test(v))
    return { color: null, fancyColor: v.replace(/^fancy\s*/i, "") || v, fancyIntensity: "Fancy" };

  return { color: v, fancyColor: null, fancyIntensity: null };
}
