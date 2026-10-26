import sharp from "sharp";
import { ValidationError } from "../destinations/types";

export type Rgb = [number, number, number];
/** A white-point calibration of one source: per-channel gains (linear light) and the paper white they were made from. */
export type WhiteCalibration = { gains: Rgb; white: Rgb; at: number };

/** More correction than this means the sheet isn't white (or isn't paper): refuse rather than tint every scan. */
export const MAX_GAIN = 1.25;
/** The brightest channel of white paper, after the ICC profile, must reach this (sRGB 0-255). */
const MIN_WHITE = 170;
/** Standard deviation per channel (sRGB 0-255) above which the patch has something on it. */
const MAX_SD = 12;

/** sRGB 0-255 → linear 0-1. */
const linear = (v: number) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);

/**
 * Gains that make a measured paper white neutral: each channel is raised in linear light to the brightest one, so
 * nothing gets darker. Throws ValidationError when the patch is too dark or too coloured to be white paper.
 */
export function whiteGains(white: Rgb): Rgb {
  if (Math.max(...white) < MIN_WHITE) throw new ValidationError("The patch is not white enough: put a plain white sheet on the glass and close the lid");
  const lin = white.map(linear);
  const top = Math.max(...lin);
  const gains = lin.map((v) => top / v) as Rgb;
  if (gains.some((g) => g > MAX_GAIN)) throw new ValidationError("The patch is not white (strongly coloured): use plain white paper");
  return gains;
}

/** Mean colour of the central `inner` part of a PNG, and whether it is even enough to be a blank sheet. */
export async function measureWhite(pngPath: string, inner = 0.8): Promise<{ mean: Rgb; even: boolean }> {
  const { width = 0, height = 0 } = await sharp(pngPath).metadata();
  const w = Math.max(1, Math.round(width * inner));
  const h = Math.max(1, Math.round(height * inner));
  // stats() looks at the input image, not the pipeline: crop to a buffer first.
  const crop = await sharp(pngPath)
    .extract({ left: Math.floor((width - w) / 2), top: Math.floor((height - h) / 2), width: w, height: h })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const stats = await sharp(crop.data, { raw: crop.info }).stats();
  const ch = stats.channels.slice(0, 3);
  return { mean: ch.map((c) => c.mean) as Rgb, even: ch.every((c) => c.stdev <= MAX_SD) };
}
