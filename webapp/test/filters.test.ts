import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream } from "pdf-lib";
import sharp from "sharp";
import { openDb } from "../src/server/db";
import { encodeOutputs } from "../src/server/output/encode";
import { makeThumb } from "../src/server/pipeline/pages";
import { applyFilter, DEFAULT_FILTER, effectiveFilter, isNoopFilter, validateFilter, type Filter } from "../src/server/pipeline/filters";
import { magickAvailable, runMagick } from "../src/server/pipeline/magick";
import { ValidationError } from "../src/server/profiles";
import { ProfileRepo } from "../src/server/repos/profile-repo";
import { ProfileService } from "../src/server/services/profile-service";
import { SecretBox } from "../src/server/secrets";
import { tmpdir } from "./helpers";

const fx = (name: string) => join(import.meta.dir, "fixtures", name);
const f = (over: Partial<Filter>): Filter => ({ ...DEFAULT_FILTER, ...over });

async function flat(dir: string, name: string, gray: number, w = 200, h = 150): Promise<string> {
  const p = join(dir, name);
  const hex = gray.toString(16).padStart(2, "0");
  await sharp({ create: { width: w, height: h, channels: 3, background: `#${hex}${hex}${hex}` } }).png().toFile(p);
  return p;
}

/** Text page on a light-gray (230) background. */
async function grayPaper(dir: string): Promise<string> {
  const p = join(dir, "paper.png");
  const text = await sharp(fx("upright-text.png")).toColourspace("b-w").raw().toBuffer({ resolveWithObject: true });
  // Map white -> 230, black stays black.
  const px = Buffer.from(text.data.map((v) => Math.round((v / 255) * 230)));
  await sharp(px, { raw: { width: text.info.width, height: text.info.height, channels: 1 } }).png().toFile(p);
  return p;
}

const mean = async (p: string) => (await sharp(p).stats()).channels[0]!.mean;

describe("applyFilter", () => {
  test("bw output is 1-bit and only 0/255", async () => {
    const d = tmpdir();
    const out = join(d, "bw.png");
    await applyFilter(fx("upright-text.png"), f({ preset: "bw", threshold: 128 }), out);
    expect((await sharp(out).metadata()).bitsPerSample).toBe(1);
    const { data } = await sharp(out).toColourspace("b-w").raw().toBuffer({ resolveWithObject: true });
    expect(new Set(data)).toEqual(new Set([0, 255]));
  });

  test("gray output has 1 channel", async () => {
    const d = tmpdir();
    const src = join(d, "c.png");
    await sharp({ create: { width: 50, height: 40, channels: 3, background: "#ff8000" } }).png().toFile(src);
    const out = join(d, "g.png");
    expect(await applyFilter(src, f({ preset: "gray" }), out)).toEqual({ width: 50, height: 40 });
    expect((await sharp(out).metadata()).channels).toBe(1);
  });

  test("document makes a light-gray (230) background >= 245", async () => {
    const d = tmpdir();
    const src = await grayPaper(d);
    const out = join(d, "doc.png");
    await applyFilter(src, f({ preset: "document" }), out);
    // background = the median-ish bright pixels; use the top-left corner area, which is margin
    const { data } = await sharp(out).extract({ left: 0, top: 0, width: 40, height: 40 }).toColourspace("b-w").raw().toBuffer({ resolveWithObject: true });
    expect(Math.min(...data)).toBeGreaterThanOrEqual(245);
  });

  test("document keeps colours (3 channels)", async () => {
    const d = tmpdir();
    const src = join(d, "c.png");
    await sharp({ create: { width: 50, height: 40, channels: 3, background: "#ff8000" } }).png().toFile(src);
    await applyFilter(src, f({ preset: "document" }), join(d, "o.png"));
    expect((await sharp(join(d, "o.png")).metadata()).channels).toBe(3);
  });

  test("brightness +50 raises mean; contrast changes spread", async () => {
    const d = tmpdir();
    const src = await flat(d, "g.png", 100);
    await applyFilter(src, f({ brightness: 50 }), join(d, "b.png"));
    expect(await mean(join(d, "b.png"))).toBeGreaterThan((await mean(src)) + 40);
    await applyFilter(src, f({ brightness: -50 }), join(d, "dk.png"));
    expect(await mean(join(d, "dk.png"))).toBeLessThan((await mean(src)) - 40);
    await applyFilter(src, f({ contrast: 50 }), join(d, "c.png"));
    // 100 is below mid-gray, so more contrast makes it darker
    expect(await mean(join(d, "c.png"))).toBeLessThan(await mean(src));
  });

  test("autoCrop on a page with a white border returns smaller dimensions", async () => {
    const d = tmpdir();
    const src = join(d, "border.png");
    await sharp({ create: { width: 800, height: 600, channels: 3, background: "#ffffff" } })
      .composite([{ input: { create: { width: 300, height: 200, channels: 3, background: "#404040" } }, left: 250, top: 200 }])
      .png()
      .toFile(src);
    const r = await applyFilter(src, f({ autoCrop: true }), join(d, "crop.png"));
    expect(r.width).toBeLessThan(800);
    expect(r.height).toBeLessThan(600);
    expect(r).toEqual({ width: 300, height: 200 });
  });

  test("autoCrop on a blank page leaves it as is", async () => {
    const d = tmpdir();
    const src = await flat(d, "blank.png", 255);
    expect(await applyFilter(src, f({ autoCrop: true }), join(d, "o.png"))).toEqual({ width: 200, height: 150 });
  });

  test.skipIf(!magickAvailable())("deskew straightens a page rotated 3 degrees to within 0.5", async () => {
    const d = tmpdir();
    const tilted = join(d, "tilted.png");
    await runMagick([fx("upright-text.png"), "-background", "white", "-rotate", "3", `PNG:${tilted}`]);
    const angle = async (p: string) =>
      Math.abs(Number(new TextDecoder().decode(await runMagick([p, "-deskew", "40%", "-format", "%[deskew:angle]", "info:"]))));
    expect(await angle(tilted)).toBeGreaterThan(2);
    const out = join(d, "straight.png");
    await applyFilter(tilted, f({ deskew: true }), out);
    expect(await angle(out)).toBeLessThan(0.5);
  });

  test("none leaves bytes identical", async () => {
    const d = tmpdir();
    const out = join(d, "same.png");
    expect(isNoopFilter(DEFAULT_FILTER)).toBe(true);
    expect(await applyFilter(fx("upright-text.png"), DEFAULT_FILTER, out)).toEqual({ width: 1120, height: 417 });
    expect(Buffer.compare(readFileSync(out), readFileSync(fx("upright-text.png")))).toBe(0);
  });
});

test("effectiveFilter: page override wins entirely", () => {
  const scan = f({ preset: "gray", brightness: 20 });
  const page = f({ preset: "bw" });
  expect(effectiveFilter(scan, null)).toEqual(scan);
  expect(effectiveFilter(scan, page)).toEqual(page);
});

test("validateFilter rejects out-of-range values", () => {
  expect(validateFilter(DEFAULT_FILTER)).toEqual(DEFAULT_FILTER);
  expect(() => validateFilter({ ...DEFAULT_FILTER, preset: "sepia" })).toThrow(ValidationError);
  expect(() => validateFilter({ ...DEFAULT_FILTER, brightness: 101 })).toThrow(ValidationError);
  expect(() => validateFilter({ ...DEFAULT_FILTER, threshold: -1 })).toThrow(ValidationError);
  expect(() => validateFilter({ ...DEFAULT_FILTER, deskew: "yes" })).toThrow(ValidationError);
});

test("encodeOutputs applies the scan filter with per-page override", async () => {
  const d = tmpdir();
  const page = { path: fx("upright-text.png"), dpi: 150, mode: "gray" };
  const files = await encodeOutputs(
    [{ ...page, filter: null }, { ...page, filter: f({ preset: "bw" }) }],
    { id: 1, name: "x", format: "pdf_multi", jpegQuality: 80, filenameTemplate: "x", destination: { type: "download", config: {} } },
    { date: new Date(), outputProfile: "x", inputProfile: "y", seq: 1 },
    join(d, "out"),
    f({ preset: "gray" }),
  );
  const doc = await PDFDocument.load(readFileSync(files[0]!.path));
  const bits = [0, 1].map((i) => {
    const xo = doc.getPage(i).node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
    const s = xo.lookup(xo.keys()[0]!) as PDFRawStream;
    return [(s.dict.lookup(PDFName.of("BitsPerComponent")) as PDFNumber).asNumber(), String(s.dict.lookup(PDFName.of("ColorSpace")))];
  });
  expect(bits).toEqual([
    [8, "/DeviceGray"],
    [1, "/DeviceGray"],
  ]);
});

test("makeThumb takes an optional filter", async () => {
  const d = tmpdir();
  await makeThumb(fx("upright-text.png"), join(d, "t.jpg"), f({ preset: "bw" }));
  const meta = await sharp(join(d, "t.jpg")).metadata();
  expect(meta.format).toBe("jpeg");
  expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(300);
});

test("input profiles carry a default filter, persisted", () => {
  const repo = new ProfileRepo(openDb(":memory:"), new SecretBox("s"));
  const service = new ProfileService(repo);
  const plain = service.createInput({ name: "Plain", source: "adf", mode: "gray", dpi: 300, paper: "a4", autoOrient: false, threshold: 128 });
  expect(repo.getInput(plain.id)!.filter).toEqual(DEFAULT_FILTER);
  const saved = service.createInput({ ...repo.listInput()[0]!, name: "Doc", filter: f({ preset: "document", deskew: true }) });
  expect(repo.getInput(saved.id)!.filter).toEqual(f({ preset: "document", deskew: true }));
  expect(() => service.updateInput(saved.id, { ...saved, filter: { ...DEFAULT_FILTER, contrast: 500 } })).toThrow(ValidationError);
});

describe("16-bit pages", () => {
  async function png16(dir: string): Promise<string> {
    const w = 64, h = 48;
    const px = new Uint16Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) px[(y * w + x) * 3 + c] = x < w / 2 ? 0x1000 : 0xe000 + c * 0x100;
    const p = join(dir, "p16.png");
    await sharp(px, { raw: { width: w, height: h, channels: 3 } }).toColourspace("rgb16").png().toFile(p);
    return p;
  }
  const meta = (p: string) => sharp(p).metadata();

  test("brightness, sharpen and gray keep 16 bits; black & white is 1-bit", async () => {
    const d = tmpdir();
    const src = await png16(d);
    const out = (n: string) => join(d, n);
    await applyFilter(src, f({ brightness: 10 }), out("b.png"));
    expect((await meta(out("b.png"))).depth).toBe("ushort");
    await applyFilter(src, f({ sharpen: "normal" }), out("s.png"), { dpi: 600, rotation: 0 });
    expect((await meta(out("s.png"))).depth).toBe("ushort");
    await applyFilter(src, f({ preset: "gray" }), out("g.png"));
    expect(await meta(out("g.png"))).toMatchObject({ depth: "ushort", channels: 1 });
    await applyFilter(src, f({ preset: "bw" }), out("bw.png"));
    expect((await meta(out("bw.png"))).bitsPerSample).toBe(1);
  });
});
