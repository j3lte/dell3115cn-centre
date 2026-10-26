import { ValidationError } from "../destinations/types";
import type { AreaMm } from "../services/scan-service";

/** Long side of images handed to an assistant (vision models downscale anything larger). */
export const LLM_MAX_PX = 1568;

/** The flatbed's scan area: 8490 x 11685 mils, the limit the scanner service enforces. */
export const GLASS_MM: [number, number] = [215.6, 296.8];

/**
 * A rectangle on a stored page (turned `rotation` degrees clockwise after scanning, `pageWmm` x `pageHmm` as stored)
 * mapped back to the page as it came off the scanner.
 */
export function unrotateRect(rect: AreaMm, pageWmm: number, pageHmm: number, rotation: number): AreaMm {
  const [x, y, w, h] = rect;
  const W = pageWmm, H = pageHmm;
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      return [y, W - x - w, h, w];
    case 180:
      return [W - x - w, H - y - h, w, h];
    case 270:
      return [H - y - h, x, h, w];
    default:
      return [x, y, w, h];
  }
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * A rectangle (mm) on a stored flatbed page → glass coordinates (mm) for a new region scan: undo the page's rotation,
 * add the offset of the region the page was scanned from (`scanArea`, null = whole glass), clamp to the glass.
 */
export function pageRectToGlass(
  rect: AreaMm,
  page: { widthPx: number; heightPx: number; dpi: number; rotation: number },
  scanArea: AreaMm | null,
): AreaMm {
  const mm = 25.4 / page.dpi;
  const [ux, uy, uw, uh] = unrotateRect(rect, page.widthPx * mm, page.heightPx * mm, page.rotation);
  const x0 = Math.max(0, ux + (scanArea?.[0] ?? 0));
  const y0 = Math.max(0, uy + (scanArea?.[1] ?? 0));
  const x1 = Math.min(GLASS_MM[0], ux + uw + (scanArea?.[0] ?? 0));
  const y1 = Math.min(GLASS_MM[1], uy + uh + (scanArea?.[1] ?? 0));
  if (!(x1 - x0 > 0.5 && y1 - y0 > 0.5)) throw new ValidationError("That area is empty or outside the glass");
  return [round2(x0), round2(y0), round2(x1 - x0), round2(y1 - y0)];
}
