import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { PdfImage } from "./pdf-writer";
import { pngToPdfImage } from "./png";

/** Same mark the admin print preview renders, so screen and PDF agree. */
const LOGO_PATH = join(__dirname, "assets", "radiia-logo.png");

let cached: PdfImage | null | undefined;

/**
 * The RADIIA letterhead mark, decoded once per process. Returns null when the
 * asset cannot be read or decoded, so a document still renders — with the plain
 * wordmark — instead of failing the download outright.
 */
export function brandLogo(): PdfImage | null {
  if (cached !== undefined) return cached;
  try {
    cached = pngToPdfImage(readFileSync(LOGO_PATH));
  } catch (err) {
    console.error("[pdf] could not load the RADIIA letterhead logo", err);
    cached = null;
  }
  return cached;
}
