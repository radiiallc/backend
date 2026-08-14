
const VIDEO_FILE_RE = /\.(mp4|webm|ogg|mov|m4v)(\?|#|$)/i;
const IMAGE_FILE_RE = /\.(jpe?g|png|gif|webp|avif|bmp|svg)(\?|#|$)/i;

export const isDirectVideoFile = (url: string): boolean => VIDEO_FILE_RE.test(url);

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
  const d360 = url.match(/^https?:\/\/(?:www\.)?d360\.tech\/[^?#]*\?(?:[^#]*&)?d=([^&#]+)/i);
  if (d360) return `https://d360.tech/imaged/${d360[1]}/still.jpg`;

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
