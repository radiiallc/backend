import { imageFromRgb, type PdfImage } from "./pdf-writer";

import { inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Samples per pixel, by PNG colour type. Palette (3) is deliberately absent. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Reverses the per-row PNG filters in place, leaving plain interleaved samples.
 * PDF can apply the same predictors itself, but only for streams it stores
 * whole — an RGBA source has to be split into colour and alpha first, so the
 * filtering has to be undone here.
 */
function unfilter(raw: Buffer, width: number, height: number, channels: number): Buffer {
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) {
    throw new Error("PNG image data is truncated");
  }

  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = raw[pos];
    pos += 1;
    const cur = out.subarray(row * stride, (row + 1) * stride);
    const prev = row > 0 ? out.subarray((row - 1) * stride, row * stride) : null;

    for (let i = 0; i < stride; i += 1) {
      const x = raw[pos + i];
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = x;
          break;
        case 1:
          value = x + a;
          break;
        case 2:
          value = x + b;
          break;
        case 3:
          value = x + ((a + b) >> 1);
          break;
        case 4:
          value = x + paeth(a, b, c);
          break;
        default:
          throw new Error(`unsupported PNG row filter ${filter}`);
      }
      cur[i] = value & 0xff;
    }
    pos += stride;
  }
  return out;
}

/**
 * Decodes a non-interlaced 8-bit PNG into a PDF image XObject. Only the colour
 * types our own assets use are handled; anything else throws rather than
 * rendering silently wrong, since a mis-decoded letterhead is worse than none.
 */
export function pngToPdfImage(png: Buffer): PdfImage {
  if (png.length < 8 || !png.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error("file is not a PNG");
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let sawHeader = false;
  const idat: Buffer[] = [];

  let offset = 8;
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length; // length + type + data + CRC

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
      sawHeader = true;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (!sawHeader) throw new Error("PNG has no IHDR chunk");
  if (idat.length === 0) throw new Error("PNG has no image data");
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error("interlaced PNGs are not supported");

  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);

  const samples = unfilter(inflateSync(Buffer.concat(idat)), width, height, channels);

  const pixels = width * height;
  const rgb = Buffer.alloc(pixels * 3);
  const hasAlpha = channels === 2 || channels === 4;
  let alpha: Buffer | null = hasAlpha ? Buffer.alloc(pixels) : null;

  for (let p = 0; p < pixels; p += 1) {
    const src = p * channels;
    const dst = p * 3;
    if (channels >= 3) {
      rgb[dst] = samples[src];
      rgb[dst + 1] = samples[src + 1];
      rgb[dst + 2] = samples[src + 2];
      if (alpha) alpha[p] = samples[src + 3];
    } else {
      const gray = samples[src];
      rgb[dst] = gray;
      rgb[dst + 1] = gray;
      rgb[dst + 2] = gray;
      if (alpha) alpha[p] = samples[src + 1];
    }
  }

  // A fully opaque alpha channel costs an object and a stream for nothing.
  if (alpha && alpha.every((v) => v === 0xff)) alpha = null;

  return imageFromRgb(width, height, rgb, alpha);
}
