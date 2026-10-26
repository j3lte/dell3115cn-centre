import type { Filter } from "../types/api";
import { PRESET_LABELS } from "./labels";

export const DEFAULT_FILTER: Filter = { preset: "none", threshold: 160, brightness: 0, contrast: 0, autoCrop: false, deskew: false, sharpen: "off" };

/** Short human summary, e.g. "Document · straighten · +20 brightness". */
export function filterSummary(f: Filter): string {
  const parts = [PRESET_LABELS[f.preset]];
  if (f.brightness) parts.push(`${f.brightness > 0 ? "+" : ""}${f.brightness} brightness`);
  if (f.contrast) parts.push(`${f.contrast > 0 ? "+" : ""}${f.contrast} contrast`);
  if (f.autoCrop) parts.push("auto-crop");
  if (f.deskew) parts.push("straighten");
  if (f.sharpen === "light") parts.push("light sharpen");
  if (f.sharpen === "normal") parts.push("sharpen");
  return parts.join(" · ");
}
