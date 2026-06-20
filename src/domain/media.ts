// Vendor media URLs arrive in several shapes: direct image/video files,
// v360.diamonds still endpoints (?m=t serves a raw JPEG), and HTML viewer
// pages (d360.tech still/view/detail.html, Vision360.html, lgdus .html, …)
// that can only render in an iframe. These helpers classify URLs and, where
// the vendor exposes a predictable still path, derive a direct <img>-loadable
// preview from a viewer-page URL.

const VIDEO_FILE_RE = /\.(mp4|webm|ogg|mov|m4v)(\?|#|$)/i;
const IMAGE_FILE_RE = /\.(jpe?g|png|gif|webp|avif|bmp|svg)(\?|#|$)/i;

export const isDirectVideoFile = (url: string): boolean => VIDEO_FILE_RE.test(url);

// Vendor feed cells occasionally jam two URLs together with no separator (e.g.
// "https://…/x.mp4?tr=f-mp4https://…/y.png?tr=f-jpg"). The ingest parser fixes
// new writes, but pre-fix rows in the DB remain corrupted until the next cron
// upsert. Apply the same split at read time so callers always see a clean URL.
export function sanitizeMediaUrl(
  url: string | null | undefined,
  kind: "video" | "image"
): string | null {
  if (!url) return null;
  const segments = url
    .split(/(?=https?:\/\/)/i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length <= 1) return url;
  const prefer = kind === "video" ? VIDEO_FILE_RE : IMAGE_FILE_RE;
  const avoid = kind === "video" ? IMAGE_FILE_RE : VIDEO_FILE_RE;
  return (
    segments.find((u) => prefer.test(u)) ??
    segments.find((u) => !avoid.test(u)) ??
    segments[0]
  );
}

export const isV360Still = (url: string): boolean =>
  /v360\.diamonds\//i.test(url) && /[?&]m=t(?:&|$)/i.test(url);

export const isDirectImageFile = (url: string): boolean =>
  /\.(jpe?g|png|gif|webp|avif|bmp|svg)(\?|#|$)/i.test(url) || isV360Still(url);

export const isImageEmbed = (url: string | null | undefined): boolean =>
  Boolean(url) && !isDirectImageFile(url as string);

function deriveStillFromUrl(url: string): string | null {
  // d360.tech viewer pages (still.html / view.html / detail.html ?d=<id>)
  // wrap a JPEG that lives at https://d360.tech/imaged/<id>/still.jpg.
  const d360 = url.match(/^https?:\/\/(?:www\.)?d360\.tech\/[^?#]*\?(?:[^#]*&)?d=([^&#]+)/i);
  if (d360) return `https://d360.tech/imaged/${d360[1]}/still.jpg`;

  // v360.diamonds /u/<id>?m=d is the 360 viewer; ?m=t on the same path is the
  // raw JPEG still. (/c/<uuid> links are excluded — that endpoint is currently
  // dead, returning 402 Payment Required.)
  try {
    const u = new URL(url);
    if (/(^|\.)v360\.diamonds$/i.test(u.hostname) && u.pathname.startsWith("/u/") && u.searchParams.get("m") === "d") {
      u.searchParams.set("m", "t");
      return u.toString();
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Best direct-image preview URL for a stone, or null when none is derivable.
 * - Direct image photoUrl (incl. v360 ?m=t stills) → as-is.
 * - Viewer-page photoUrl with a known still path → derived JPEG.
 * - Unknown embed photoUrl → passed through (callers' <img> onError fallbacks
 *   decide; some extension-less URLs do serve image bytes).
 * - No photoUrl → poster derived from the video viewer URL when possible.
 */
export function resolveStillImageUrl(
  photoUrl: string | null | undefined,
  videoUrl?: string | null
): string | null {
  const cleanPhoto = sanitizeMediaUrl(photoUrl, "image");
  const cleanVideo = sanitizeMediaUrl(videoUrl, "video");
  if (cleanPhoto) {
    if (isDirectImageFile(cleanPhoto)) return cleanPhoto;
    return deriveStillFromUrl(cleanPhoto) ?? cleanPhoto;
  }
  if (cleanVideo) return deriveStillFromUrl(cleanVideo);
  return null;
}
