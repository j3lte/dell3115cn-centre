import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { appDir } from "../app-dir";
import { runMagick } from "./magick";

/**
 * The scanner's own colour profile, from Dell's Windows driver. It is not redistributed (Dell copyright), so it is
 * looked for at `DEVICE_ICC` or in `assets/` (see assets/README.md). Without it colour scans have a magenta cast.
 */
export const BUNDLED_DEVICE_ICC = join(appDir, "assets", "dell3115cn.icm");

/** The device profile to use: env DEVICE_ICC (if that file exists), else the copy in assets/, else null. */
export function deviceIccPath(env: Record<string, string | undefined> = process.env, bundled = BUNDLED_DEVICE_ICC): string | null {
  // A bind mount of a file that doesn't exist on the host shows up as an empty directory: not a profile.
  const isFile = (p: string) => existsSync(p) && statSync(p).isFile();
  if (env.DEVICE_ICC) return isFile(env.DEVICE_ICC) ? env.DEVICE_ICC : null;
  return isFile(bundled) ? bundled : null;
}

const SRGB_CANDIDATES = [
  "/usr/share/color/icc/colord/sRGB.icc", // colord's profile (Docker image)
  "/System/Library/ColorSync/Profiles/sRGB Profile.icc", // macOS (development)
];

/** sRGB target profile: env SRGB_ICC, else the first existing well-known path. */
export function srgbIccPath(env: Record<string, string | undefined> = process.env): string {
  if (env.SRGB_ICC) return env.SRGB_ICC;
  const found = SRGB_CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new Error("No sRGB ICC profile found; set SRGB_ICC");
  return found;
}

/**
 * Colour PNM (device RGB) → sRGB PNG via the device ICC profile (when available), 8 or 16 bits per channel.
 * `whiteGains` (from a white calibration) multiply R, G and B in linear light after the profile.
 */
export async function colorPnmToPng(
  pnm: Uint8Array,
  outPath: string,
  depth: 8 | 16 = 8,
  icc: string | null = deviceIccPath(),
  whiteGains?: [number, number, number],
): Promise<void> {
  const out = depth === 16 ? `PNG48:${outPath}` : `PNG24:${outPath}`;
  const profiles = icc ? ["-profile", icc, "-profile", srgbIccPath()] : [];
  const gains = whiteGains?.some((g) => g !== 1)
    ? [
        "-colorspace", "RGB",
        ...whiteGains.flatMap((g, i) => (g === 1 ? [] : ["-channel", "RGB"[i]!, "-evaluate", "multiply", String(g)])),
        "+channel", "-colorspace", "sRGB",
      ]
    : [];
  await runMagick(["pnm:-", ...profiles, ...gains, "-depth", String(depth), out], pnm);
}
