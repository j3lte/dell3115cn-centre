import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp, { type Sharp } from "sharp";
import { ValidationError } from "../destinations/types";
import { deconvolveRaw, psfSigmas, SHARPEN_ITERATIONS, type Sharpen } from "./deconvolve";
import { runMagick } from "./magick";
import { bilevelPng } from "./pnm";

export type FilterPreset = "none" | "document" | "gray" | "bw";

export type Filter = {
  preset: FilterPreset;
  threshold: number; // 0-255, bw only
  brightness: number; // -100..100
  contrast: number; // -100..100
  autoCrop: boolean;
  deskew: boolean;
  /** Deconvolution with the scanner's measured blur; filters stored before it existed lack the field (= off). */
  sharpen?: Sharpen;
};

export const DEFAULT_FILTER: Filter = { preset: "none", threshold: 160, brightness: 0, contrast: 0, autoCrop: false, deskew: false, sharpen: "off" };

const PRESETS: FilterPreset[] = ["none", "document", "gray", "bw"];

/** Checks an untrusted filter object and returns a clean copy. */
export function validateFilter(x: unknown): Filter {
  if (!x || typeof x !== "object") throw new ValidationError("Filter must be an object");
  const o = x as Record<string, unknown>;
  const int = (k: string, min: number, max: number) => {
    const v = o[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new ValidationError(`Filter ${k} must be ${min}..${max}`);
    return Math.round(v);
  };
  const bool = (k: string) => {
    if (typeof o[k] !== "boolean") throw new ValidationError(`Filter ${k} must be true or false`);
    return o[k] as boolean;
  };
  if (!PRESETS.includes(o.preset as FilterPreset)) throw new ValidationError(`Unknown filter preset: ${String(o.preset)}`);
  const sharpen = o.sharpen ?? "off";
  if (!(typeof sharpen === "string" && sharpen in SHARPEN_ITERATIONS)) throw new ValidationError(`Unknown sharpen level: ${String(sharpen)}`);
  return {
    preset: o.preset as FilterPreset,
    threshold: int("threshold", 0, 255),
    brightness: int("brightness", -100, 100),
    contrast: int("contrast", -100, 100),
    autoCrop: bool("autoCrop"),
    deskew: bool("deskew"),
    sharpen: sharpen as Sharpen,
  };
}

/** A per-page override replaces the scan filter entirely. */
export function effectiveFilter(scanFilter: Filter, pageFilter: Filter | null): Filter {
  return pageFilter ?? scanFilter;
}

export function isNoopFilter(f: Filter): boolean {
  return f.preset === "none" && f.brightness === 0 && f.contrast === 0 && !f.autoCrop && !f.deskew && (f.sharpen ?? "off") === "off";
}

/** Raw pixels; 16-bit pages (16-bit colour scans) travel as Uint16Array so the filters keep their depth. */
type Raw = { data: Buffer | Uint16Array; info: { width: number; height: number; channels: 1 | 2 | 3 | 4 } };

const wide = (r: Raw) => r.data instanceof Uint16Array;

const fromRaw = (r: Raw) => sharp(r.data, { raw: r.info });

async function toRaw(img: Sharp, sixteen = false): Promise<Raw> {
  const { data, info } = await (sixteen ? img.raw({ depth: "ushort" }) : img.raw()).toBuffer({ resolveWithObject: true });
  const out = sixteen ? new Uint16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length)) : data;
  return { data: out, info: { width: info.width, height: info.height, channels: info.channels as Raw["info"]["channels"] } };
}

/** One materialised step, so operations run in exactly the order written (sharp reorders within one pipeline). */
const step = (r: Raw, fn: (s: Sharp) => Sharp) => toRaw(fn(fromRaw(r)), wide(r));

const gray = (s: Sharp, sixteen = false) => s.toColourspace(sixteen ? "grey16" : "b-w");

/** PNG of raw pixels at their own depth. */
function png(r: Raw): Sharp {
  const img = fromRaw(r);
  if (r.info.channels === 1) return gray(img, wide(r)).png();
  return (wide(r) ? img.toColourspace("rgb16") : img).png();
}

/** What the filter needs to know about the page: scan resolution and how far the stored PNG was turned. */
export type PageGeometry = { dpi: number; rotation: number };

/**
 * Applies a filter to a page PNG and writes the result as PNG. Order: sharpen → deskew → auto-crop → preset →
 * brightness/contrast (for black-and-white, brightness/contrast come before the threshold so they still matter).
 * Sharpening models the scanner's blur, so it runs first, on unresampled pixels, and only when `page` is given
 * (previews are downscaled and skip it). A no-op filter copies the file unchanged.
 */
export async function applyFilter(srcPng: string, f: Filter, outPath: string, page?: PageGeometry): Promise<{ width: number; height: number }> {
  if (isNoopFilter(f)) {
    if (srcPng !== outPath) copyFileSync(srcPng, outPath);
    const m = await sharp(outPath).metadata();
    return { width: m.width!, height: m.height! };
  }
  const srcMeta = await sharp(srcPng).metadata();
  const srcBilevel = srcMeta.bitsPerSample === 1;
  const src16 = srcMeta.depth === "ushort";
  let work: string | null = null;
  try {
    let input = srcPng;
    const iterations = SHARPEN_ITERATIONS[f.sharpen ?? "off"];
    if (iterations && page && !srcBilevel) {
      work = mkdtempSync(join(tmpdir(), "scan-filter-"));
      const r = await toRaw(sharp(input).flatten({ background: "#ffffff" }), src16);
      const sharpened = deconvolveRaw(r.data, r.info.width, r.info.height, r.info.channels === 1 ? 1 : 3, iterations, psfSigmas(page.dpi, page.rotation));
      input = join(work, "sharpened.png");
      await png({ data: sharpened, info: r.info }).toFile(input);
    }
    if (f.deskew) {
      work ??= mkdtempSync(join(tmpdir(), "scan-filter-"));
      const deskewed = join(work, "deskewed.png");
      await runMagick([input, "-background", "white", "-deskew", "40%", "+repage", `PNG:${deskewed}`]);
      input = deskewed;
    }
    let r = await toRaw(sharp(input).flatten({ background: "#ffffff" }), src16);
    if (r.info.channels === 1 || srcBilevel) r = await step(r, (s) => gray(s, wide(r)));
    // Offsets below are in 8-bit units; 16-bit pages scale them.
    const unit = wide(r) ? 257 : 1;

    if (f.autoCrop) {
      try {
        r = await step(r, (s) => s.trim({ threshold: 25 * unit }));
      } catch {
        // nothing to trim (blank page): keep as is
      }
    }

    const a = 1 + f.contrast / 100;
    const b = (f.brightness * 1.28 - 128 * (a - 1)) * unit;
    const adjust = f.brightness !== 0 || f.contrast !== 0;

    if (f.preset === "gray") r = await step(r, (s) => gray(s, wide(r)));
    else if (f.preset === "document") {
      r = await step(r, (s) => s.normalise());
      r = await step(r, (s) => s.linear(1.15, -15 * unit));
      r = await step(r, (s) => s.sharpen());
    }

    let bilevel = false;
    if (f.preset === "bw") {
      r = await step(r, (s) => gray(s, wide(r)));
      if (adjust) r = await step(r, (s) => s.linear(a, b));
      if (wide(r)) r = await toRaw(gray(fromRaw(r))); // to 8 bits: the threshold is in 8-bit units
      r = await step(r, (s) => s.threshold(f.threshold));
      bilevel = true;
    } else if (adjust) {
      r = await step(r, (s) => s.linear(a, b));
    }
    // A lineart scan stays 1-bit unless the filter introduces gray levels.
    if (!bilevel && srcBilevel && !f.deskew && f.preset !== "document" && !adjust) {
      r = await step(r, (s) => s.threshold(128));
      bilevel = true;
    }

    if (bilevel) {
      let out = fromRaw(r);
      if (r.info.channels === 1) out = gray(out);
      await bilevelPng(out).toFile(outPath);
    } else await png(r).toFile(outPath);
    return { width: r.info.width, height: r.info.height };
  } finally {
    if (work) rmSync(work, { recursive: true, force: true });
  }
}
