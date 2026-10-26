import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { applyFilter, isNoopFilter, type Filter } from "./filters";
import { detectRotation, rotatePng, type Rotation } from "./orient";
import { pnmToPng } from "./pnm";

export const THUMB_MAX_PX = 300;
/** Filters run on a downscaled copy for thumbnails; this keeps them fast on 600 dpi pages. */
const THUMB_FILTER_PX = 1200;

export const VIEW_MAX_PX = 1600;

/**
 * JPEG thumbnail, at most `maxPx` (default THUMB_MAX_PX) on the long side (never enlarged), optionally with a filter
 * applied. Also renders the large page view (VIEW_MAX_PX).
 */
export async function makeThumb(pngPath: string, thumbPath: string, filter?: Filter, maxPx = THUMB_MAX_PX): Promise<void> {
  let src = pngPath;
  let work: string | null = null;
  try {
    if (filter && !isNoopFilter(filter)) {
      work = mkdtempSync(join(tmpdir(), "scan-thumb-"));
      const small = join(work, "small.png");
      await sharp(pngPath).resize(Math.max(THUMB_FILTER_PX, maxPx), Math.max(THUMB_FILTER_PX, maxPx), { fit: "inside", withoutEnlargement: true }).png().toFile(small);
      src = join(work, "filtered.png");
      await applyFilter(small, filter, src);
    }
    await sharp(src)
      .resize(maxPx, maxPx, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: maxPx > THUMB_MAX_PX ? 80 : 70 })
      .toFile(thumbPath);
  } finally {
    if (work) rmSync(work, { recursive: true, force: true });
  }
}

/** Scanner PNM → upright PNG original (+ thumbnail). */
export async function processPage(
  pnm: Uint8Array,
  opts: {
    mode: "lineart" | "gray" | "color";
    autoOrient: boolean;
    outPath: string;
    thumbPath: string;
    filter?: Filter;
    /** White-point gains for colour pages (Settings → Colour calibration). */
    whiteGains?: [number, number, number];
  },
): Promise<{ width: number; height: number; rotation: Rotation }> {
  let { width, height } = await pnmToPng(pnm, opts.mode, opts.outPath, { whiteGains: opts.whiteGains });
  let rotation: Rotation = 0;
  if (opts.autoOrient) {
    rotation = await detectRotation(opts.outPath);
    if (rotation) {
      await rotatePng(opts.outPath, rotation);
      if (rotation !== 180) [width, height] = [height, width];
    }
  }
  await makeThumb(opts.outPath, opts.thumbPath, opts.filter);
  return { width, height, rotation };
}
