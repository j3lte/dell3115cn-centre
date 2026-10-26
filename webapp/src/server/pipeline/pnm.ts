import sharp, { type Sharp } from "sharp";
import { colorPnmToPng, deviceIccPath } from "./icc";

// libvips caches decoded files by path. Pages and thumbnails are rewritten in place (rotate, filter changes), so a
// cached decode would silently serve the old image.
sharp.cache(false);

export type PnmHeader = { kind: "P4" | "P5" | "P6"; width: number; height: number; maxval: number; dataOffset: number };

const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0b || c === 0x0c;

/** Binary PNM header (P4 bitmap, P5 graymap, P6 pixmap); comments allowed. 16-bit (maxval 65535) only for P6 colour. */
export function parsePnmHeader(buf: Uint8Array): PnmHeader {
  if (buf.length < 2 || buf[0] !== 0x50 /* P */ || ![0x34, 0x35, 0x36].includes(buf[1]!)) throw new Error("Not a binary PNM image");
  const kind = `P${String.fromCharCode(buf[1]!)}` as PnmHeader["kind"];
  const fields = kind === "P4" ? 2 : 3;
  const values: number[] = [];
  let i = 2;
  while (values.length < fields) {
    if (i >= buf.length) throw new Error("Truncated PNM header");
    const c = buf[i]!;
    if (isSpace(c)) {
      i++;
    } else if (c === 0x23 /* # */) {
      while (i < buf.length && buf[i] !== 0x0a && buf[i] !== 0x0d) i++;
    } else if (c >= 0x30 && c <= 0x39) {
      let v = 0;
      while (i < buf.length && buf[i]! >= 0x30 && buf[i]! <= 0x39) v = v * 10 + (buf[i++]! - 0x30);
      values.push(v);
    } else {
      throw new Error("Invalid PNM header");
    }
  }
  if (i >= buf.length || !isSpace(buf[i]!)) throw new Error("Invalid PNM header");
  const [width, height, maxval] = values as [number, number, number?];
  if (!width || !height) throw new Error("PNM has zero size");
  if (maxval !== undefined && maxval !== 255 && !(maxval === 65535 && kind === "P6")) throw new Error(`Unsupported PNM maxval ${maxval}`);
  return { kind, width, height, maxval: maxval ?? 1, dataOffset: i + 1 };
}

/** 1-bit packed rows (1 = black) → 8-bit gray (0 black, 255 white). */
function unpackBits(data: Uint8Array, width: number, height: number): Buffer {
  const rowBytes = Math.ceil(width / 8);
  const out = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * rowBytes;
    for (let x = 0; x < width; x++) out[y * width + x] = (data[row + (x >> 3)]! >> (7 - (x & 7))) & 1 ? 0 : 255;
  }
  return out;
}

/** Writes a 1-bit (two-colour palette) PNG from 8-bit gray pixels that are only 0/255. */
export function bilevelPng(img: Sharp): Sharp {
  return img.png({ palette: true, colours: 2, compressionLevel: 9 });
}

/**
 * Scanner PNM → PNG. Colour goes through the device ICC profile (ImageMagick); gray and lineart through sharp.
 * Lineart stays a 1-bit PNG; 16-bit colour stays 16-bit.
 */
export async function pnmToPng(
  pnm: Uint8Array,
  mode: "lineart" | "gray" | "color",
  outPath: string,
  opts: { whiteGains?: [number, number, number] } = {},
): Promise<{ width: number; height: number }> {
  const h = parsePnmHeader(pnm);
  const data = pnm.subarray(h.dataOffset);
  if (mode === "color") {
    if (h.kind !== "P6") throw new Error(`Colour page is ${h.kind}, expected P6`);
    await colorPnmToPng(pnm, outPath, h.maxval === 65535 ? 16 : 8, deviceIccPath(), opts.whiteGains);
  } else if (mode === "gray") {
    if (h.kind !== "P5") throw new Error(`Gray page is ${h.kind}, expected P5`);
    if (data.length < h.width * h.height) throw new Error("Truncated PNM data");
    await sharp(data.subarray(0, h.width * h.height), { raw: { width: h.width, height: h.height, channels: 1 } })
      .toColourspace("b-w")
      .png()
      .toFile(outPath);
  } else {
    if (h.kind !== "P4") throw new Error(`Lineart page is ${h.kind}, expected P4`);
    if (data.length < Math.ceil(h.width / 8) * h.height) throw new Error("Truncated PNM data");
    await bilevelPng(sharp(unpackBits(data, h.width, h.height), { raw: { width: h.width, height: h.height, channels: 1 } })).toFile(outPath);
  }
  return { width: h.width, height: h.height };
}
