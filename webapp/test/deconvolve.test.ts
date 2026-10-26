import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import sharp from "sharp";
import { encodeOutputs } from "../src/server/output/encode";
import { deconvolveRaw, psfSigmas } from "../src/server/pipeline/deconvolve";
import { applyFilter, DEFAULT_FILTER, isNoopFilter, validateFilter, type Filter } from "../src/server/pipeline/filters";
import { tmpdir } from "./helpers";

const f = (over: Partial<Filter>): Filter => ({ ...DEFAULT_FILTER, ...over });
const W = 64;

/** Vertical black/white edge (x < w/2 black), blurred horizontally by a Gaussian of `sigma` px, gamma-encoded. */
function blurredEdge(w: number, h: number, channels: 1 | 3, sigma: number): Buffer {
  const lin = (x: number) => 0.5 * (1 + erf((x - w / 2 + 0.5) / (sigma * Math.SQRT2)));
  const out = Buffer.alloc(w * h * channels);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = Math.round(Math.pow(0.03 + 0.9 * lin(x), 1 / 2.2) * 255);
      for (let c = 0; c < channels; c++) out[(y * w + x) * channels + c] = v;
    }
  return out;
}

function erf(x: number): number {
  // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

/** 10-90 % rise width (px) of row `y`, channel 0, in linear light. */
function riseWidth(data: Buffer, w: number, channels: number, y: number): number {
  const row = Array.from({ length: w }, (_, x) => Math.pow(data[(y * w + x) * channels]! / 255, 2.2));
  const lo = row[2]!, hi = row[w - 3]!;
  const at = (frac: number) => {
    const t = lo + frac * (hi - lo);
    for (let x = 1; x < w; x++) if (row[x]! >= t) return x - 1 + (t - row[x - 1]!) / (row[x]! - row[x - 1]!);
    return w;
  };
  return at(0.9) - at(0.1);
}

describe("psfSigmas", () => {
  test("600 dpi upright: measured scanner blur", () => {
    expect(psfSigmas(600, 0)).toEqual({ x: 0.7, y: 0.87 });
  });
  test("scales with dpi", () => {
    const s = psfSigmas(300, 0);
    expect(s.x).toBeCloseTo(0.35);
    expect(s.y).toBeCloseTo(0.435);
  });
  test("90 and 270 degree rotations swap the axes", () => {
    expect(psfSigmas(600, 90)).toEqual({ x: 0.87, y: 0.7 });
    expect(psfSigmas(600, 270)).toEqual({ x: 0.87, y: 0.7 });
    expect(psfSigmas(600, 180)).toEqual({ x: 0.7, y: 0.87 });
  });
});

describe("deconvolveRaw", () => {
  const h = 40;

  test("sharpens an edge blurred by the scanner PSF", () => {
    const src = blurredEdge(W, h, 1, 0.7);
    const out = deconvolveRaw(src, W, h, 1, 10, { x: 0.7, y: 0.87 });
    expect(riseWidth(out, W, 1, 20)).toBeLessThan(riseWidth(src, W, 1, 20) * 0.7);
  });

  test("more iterations sharpen more", () => {
    const src = blurredEdge(W, h, 3, 0.7);
    const five = deconvolveRaw(src, W, h, 3, 5, { x: 0.7, y: 0.87 });
    const ten = deconvolveRaw(src, W, h, 3, 10, { x: 0.7, y: 0.87 });
    expect(riseWidth(ten, W, 3, 20)).toBeLessThan(riseWidth(five, W, 3, 20));
  });

  test("a flat page stays flat", () => {
    const src = Buffer.alloc(W * h * 3, 200);
    const out = deconvolveRaw(src, W, h, 3, 10, { x: 0.7, y: 0.87 });
    expect(Math.max(...out.map((v) => Math.abs(v - 200)))).toBeLessThanOrEqual(1);
  });

  test("strip processing gives the same result as one pass", () => {
    const src = blurredEdge(W, h, 3, 0.7);
    for (let i = 0; i < src.length; i += 7) src[i] = (src[i]! * 3) % 256; // texture, so rows differ
    const whole = deconvolveRaw(src, W, h, 3, 10, { x: 0.7, y: 0.87 }, 1000);
    const strips = deconvolveRaw(src, W, h, 3, 10, { x: 0.7, y: 0.87 }, 7);
    expect(Math.max(...whole.map((v, i) => Math.abs(v - strips[i]!)))).toBeLessThanOrEqual(1);
  });

  test("colour pages: luminance is sharpened, neutral stays neutral (no colour fringes)", () => {
    const src = blurredEdge(W, h, 3, 0.7);
    const out = deconvolveRaw(src, W, h, 3, 10, { x: 0.7, y: 0.87 });
    for (let i = 0; i < out.length; i += 3) {
      expect(Math.abs(out[i]! - out[i + 1]!)).toBeLessThanOrEqual(1);
      expect(Math.abs(out[i]! - out[i + 2]!)).toBeLessThanOrEqual(1);
    }
    expect(riseWidth(out, W, 3, 20)).toBeLessThan(riseWidth(src, W, 3, 20) * 0.7);
  });

  test("a flat colour stays the same colour", () => {
    const src = Buffer.alloc(W * h * 3);
    for (let i = 0; i < src.length; i += 3) [src[i], src[i + 1], src[i + 2]] = [40, 120, 210];
    const out = deconvolveRaw(src, W, h, 3, 10, { x: 0.7, y: 0.87 });
    expect(Math.max(...out.map((v, i) => Math.abs(v - src[i]!)))).toBeLessThanOrEqual(1);
  });

  test("a negligible blur returns the input unchanged", () => {
    const src = blurredEdge(W, h, 1, 0.7);
    expect(deconvolveRaw(src, W, h, 1, 10, { x: 0.1, y: 0.2 })).toEqual(src);
  });
});

describe("sharpen filter", () => {
  test("validateFilter: defaults to off, accepts light/normal, rejects others", () => {
    const { sharpen: _, ...noSharpen } = DEFAULT_FILTER;
    expect(validateFilter(noSharpen).sharpen).toBe("off");
    expect(validateFilter(f({ sharpen: "normal" })).sharpen).toBe("normal");
    expect(() => validateFilter({ ...DEFAULT_FILTER, sharpen: "max" })).toThrow();
  });

  test("isNoopFilter: sharpen counts, a stored filter without the field does not", () => {
    expect(isNoopFilter(f({ sharpen: "light" }))).toBe(false);
    const { sharpen: _, ...old } = DEFAULT_FILTER;
    expect(isNoopFilter(old as Filter)).toBe(true);
  });

  test("applyFilter sharpens only when the dpi is known", async () => {
    const d = tmpdir();
    const src = join(d, "edge.png");
    await sharp(blurredEdge(W, 40, 3, 0.7), { raw: { width: W, height: 40, channels: 3 } }).png().toFile(src);
    const noDpi = join(d, "a.png"), withDpi = join(d, "b.png");
    await applyFilter(src, f({ sharpen: "normal" }), noDpi);
    await applyFilter(src, f({ sharpen: "normal" }), withDpi, { dpi: 600, rotation: 0 });
    const raw = async (p: string) => (await sharp(p).raw().toBuffer({ resolveWithObject: true })).data;
    expect(await raw(noDpi)).toEqual(await raw(src));
    expect(riseWidth(await raw(withDpi), W, 3, 20)).toBeLessThan(riseWidth(await raw(src), W, 3, 20) * 0.7);
  });

  test("encodeOutputs sharpens with the page's dpi", async () => {
    const d = tmpdir();
    const src = join(d, "edge.png");
    const data = blurredEdge(W, 40, 3, 0.7);
    await sharp(data, { raw: { width: W, height: 40, channels: 3 } }).png().toFile(src);
    const profile = { id: 1, name: "o", format: "png", jpegQuality: 80, filenameTemplate: "x", destination: { type: "download", config: {} } };
    const files = await encodeOutputs([{ path: src, dpi: 600, rotation: 0, mode: "color" }], profile as never,
      { date: new Date(0), outputProfile: "o", inputProfile: "i", seq: 1 }, join(d, "out"), f({ sharpen: "normal" }));
    const out = (await sharp(files[0]!.path).raw().toBuffer({ resolveWithObject: true })).data;
    expect(riseWidth(out, W, 3, 20)).toBeLessThan(riseWidth(data, W, 3, 20) * 0.7);
  });
});

describe("16-bit", () => {
  const to16 = (b: Buffer) => Uint16Array.from(b, (v) => v * 257);
  const rise16 = (d: Uint16Array, channels: number) => riseWidth(Buffer.from(Array.from(d, (v) => v >> 8)), W, channels, 20);

  test("returns Uint16Array and sharpens", () => {
    const src = to16(blurredEdge(W, 40, 3, 0.7));
    const out = deconvolveRaw(src, W, 40, 3, 10, { x: 0.7, y: 0.87 });
    expect(out).toBeInstanceOf(Uint16Array);
    expect(rise16(out as Uint16Array, 3)).toBeLessThan(rise16(src, 3) * 0.7);
  });

  test("a flat 16-bit page stays flat", () => {
    const src = new Uint16Array(W * 40 * 3).fill(0xc000);
    const out = deconvolveRaw(src, W, 40, 3, 10, { x: 0.7, y: 0.87 }) as Uint16Array;
    expect(Math.max(...Array.from(out, (v) => Math.abs(v - 0xc000)))).toBeLessThanOrEqual(257);
  });
});
