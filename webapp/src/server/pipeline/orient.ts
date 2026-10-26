import { readFileSync } from "node:fs";
import sharp from "sharp";
import { bilevelPng } from "./pnm";

export type Rotation = 0 | 90 | 180 | 270;

/** Below this Tesseract OSD orientation confidence the page is left as scanned. */
export const MIN_ORIENTATION_CONFIDENCE = 2.0;

/**
 * Clockwise rotation that makes the page upright, from Tesseract OSD (`--psm 0`). Returns 0 when there is too little
 * text to decide or anything goes wrong (tesseract missing, timeout, unreadable image).
 */
export async function detectRotation(pngPath: string, timeoutMs = 60000): Promise<Rotation> {
  if (!Bun.which("tesseract")) return 0;
  try {
    const proc = Bun.spawn(["tesseract", pngPath, "stdout", "--psm", "0"], { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return 0;
    const rotate = Number(out.match(/Rotate:\s*(\d+)/)?.[1]);
    const confidence = Number(out.match(/Orientation confidence:\s*([\d.]+)/)?.[1]);
    if (![90, 180, 270].includes(rotate) || !(confidence >= MIN_ORIENTATION_CONFIDENCE)) return 0;
    return rotate as Rotation;
  } catch {
    return 0;
  }
}

/** Rotates a PNG clockwise in place. Never mirrors. 1-bit PNGs stay 1-bit. */
export async function rotatePng(path: string, degrees: Rotation): Promise<void> {
  if (degrees === 0) return;
  const input = readFileSync(path);
  const meta = await sharp(input).metadata();
  const img = sharp(input).rotate(degrees);
  const buf = meta.bitsPerSample === 1 ? await bilevelPng(img.grayscale()).toBuffer() : await img.png().toBuffer();
  await Bun.write(path, buf);
}
