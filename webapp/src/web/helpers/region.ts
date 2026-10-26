import type { AreaMm } from "../types/api";

/** A rectangle drawn on the preview image, in preview pixels. */
export type Rect = { x: number; y: number; w: number; h: number };

/** Scan area of the flatbed glass (8490 × 11685 mils, see docs/PROTOCOL.md). */
export const GLASS_MM = { w: 215.6, h: 296.8 };
const MIN_MM = 10;

const round1 = (v: number) => Math.round(v * 10) / 10;
const floor1 = (v: number) => Math.floor(v * 10 + 1e-6) / 10;

/** One axis: [start, length] in mm, clamped to [0, max] with a minimum length. */
function axis(a: number, len: number, scale: number, max: number): [number, number] {
  let lo = Math.min(a, a + len) * scale;
  let hi = Math.max(a, a + len) * scale;
  lo = Math.min(Math.max(lo, 0), max);
  hi = Math.min(Math.max(hi, 0), max);
  if (hi - lo < MIN_MM) {
    lo = Math.min(lo, max - MIN_MM);
    hi = lo + MIN_MM;
  }
  const start = round1(lo);
  return [start, Math.min(round1(hi - lo), floor1(max - start))];
}

/** A rectangle drawn on the preview image (preview pixels) → scan area on the glass in mm `[x, y, w, h]`. */
export function regionToMm(rect: Rect, preview: { width: number; height: number }, glassMm: { w: number; h: number } = GLASS_MM): AreaMm {
  const [x, w] = axis(rect.x, rect.w, glassMm.w / preview.width, glassMm.w);
  const [y, h] = axis(rect.y, rect.h, glassMm.h / preview.height, glassMm.h);
  return [x, y, w, h];
}
