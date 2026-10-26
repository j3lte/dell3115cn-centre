import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { colorPnmToPng, deviceIccPath, srgbIccPath } from "../src/server/pipeline/icc";
import { magickAvailable } from "../src/server/pipeline/magick";
import { detectRotation, rotatePng } from "../src/server/pipeline/orient";
import { makeThumb, processPage } from "../src/server/pipeline/pages";
import { parsePnmHeader, pnmToPng } from "../src/server/pipeline/pnm";
import { makePnm, makePnm16 } from "./fake-service";
import { tmpdir } from "./helpers";

const fx = (name: string) => join(import.meta.dir, "fixtures", name);
const hasTesseract = !!Bun.which("tesseract");
const hasMagick = magickAvailable();

/** Turn a fixture PNG into a P5 PNM, like the scanner service would send. */
async function pngToPgm(path: string): Promise<Uint8Array> {
  const { data, info } = await sharp(path).grayscale().raw().toBuffer({ resolveWithObject: true });
  const header = new TextEncoder().encode(`P5\n${info.width} ${info.height}\n255\n`);
  const out = new Uint8Array(header.length + data.length);
  out.set(header);
  out.set(data, header.length);
  return out;
}

describe("parsePnmHeader", () => {
  test("a short page from the scanner service: height padded with blanks (header rewritten in place)", () => {
    const h = new TextEncoder().encode("P5\n8    7\n255\n");
    expect(parsePnmHeader(new Uint8Array([...h, ...new Uint8Array(56)]))).toEqual({ kind: "P5", width: 8, height: 7, maxval: 255, dataOffset: h.length });
  });
  test("P5 fixture", () => {
    expect(parsePnmHeader(readFileSync(fx("gray.pgm")))).toEqual({ kind: "P5", width: 64, height: 48, maxval: 255, dataOffset: 13 });
  });
  test("P4 fixture (no maxval)", () => {
    expect(parsePnmHeader(readFileSync(fx("lineart.pbm")))).toEqual({ kind: "P4", width: 64, height: 48, maxval: 1, dataOffset: 9 });
  });
  test("P6 fixture", () => {
    expect(parsePnmHeader(readFileSync(fx("white.ppm")))).toMatchObject({ kind: "P6", width: 64, height: 48 });
  });
  test("comments and odd whitespace", () => {
    const buf = new TextEncoder().encode("P5\n# made by test\n 10\t20\n255\nxxxxxxxx");
    expect(parsePnmHeader(buf)).toEqual({ kind: "P5", width: 10, height: 20, maxval: 255, dataOffset: buf.length - 8 });
  });
  test("rejects non-PNM", () => {
    expect(() => parsePnmHeader(new TextEncoder().encode("GIF89a"))).toThrow();
  });
});

describe("pnmToPng", () => {
  test("gray dimensions and channels", async () => {
    const out = join(tmpdir(), "g.png");
    expect(await pnmToPng(readFileSync(fx("gray.pgm")), "gray", out)).toEqual({ width: 64, height: 48 });
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("png");
    expect(meta.channels).toBe(1);
  });

  test("lineart stays a 1-bit PNG with the right polarity", async () => {
    const out = join(tmpdir(), "l.png");
    // PBM: bit 1 = black. All-black page.
    await pnmToPng(makePnm("lineart", 40, 10, 0), "lineart", out);
    const meta = await sharp(out).metadata();
    expect(meta.bitsPerSample).toBe(1);
    const { data } = await sharp(out).grayscale().raw().toBuffer({ resolveWithObject: true });
    expect(Math.max(...data)).toBe(0);
  });

  test.skipIf(!hasMagick)("colour: ICC removes the cast, white stays white", async () => {
    const out = join(tmpdir(), "c.png");
    expect(await pnmToPng(readFileSync(fx("white.ppm")), "color", out)).toEqual({ width: 64, height: 48 });
    const stats = await sharp(out).stats();
    const [r, g, b] = stats.channels;
    expect(r!.mean).toBeGreaterThanOrEqual(240);
    expect(g!.mean).toBeGreaterThanOrEqual(240);
    expect(b!.mean).toBeGreaterThanOrEqual(240);
    expect((await sharp(out).metadata()).channels).toBeGreaterThanOrEqual(3);
  });

  test("an sRGB profile path is resolvable", () => {
    expect(srgbIccPath({ SRGB_ICC: "/x/y.icc" })).toBe("/x/y.icc");
  });
});

describe("orientation", () => {
  test.skipIf(!hasTesseract)("upside-down text is detected as 180", async () => {
    expect(await detectRotation(fx("upside-down-text.png"))).toBe(180);
  });

  test.skipIf(!hasTesseract)("upright text is 0", async () => {
    expect(await detectRotation(fx("upright-text.png"))).toBe(0);
  });

  test("blank page returns 0", async () => {
    const blank = join(tmpdir(), "blank.png");
    await sharp({ create: { width: 600, height: 800, channels: 3, background: "#ffffff" } }).png().toFile(blank);
    expect(await detectRotation(blank)).toBe(0);
  });

  test("missing file returns 0 (tesseract error)", async () => {
    expect(await detectRotation("/nonexistent/page.png")).toBe(0);
  });

  test("rotatePng 90 swaps dimensions, in place", async () => {
    const p = join(tmpdir(), "r.png");
    await sharp({ create: { width: 30, height: 10, channels: 3, background: "#000000" } }).png().toFile(p);
    await rotatePng(p, 90);
    const meta = await sharp(p).metadata();
    expect([meta.width, meta.height]).toEqual([10, 30]);
  });

  test("rotatePng keeps lineart 1-bit", async () => {
    const p = join(tmpdir(), "r1.png");
    await pnmToPng(makePnm("lineart", 40, 10, 0), "lineart", p);
    await rotatePng(p, 270);
    const meta = await sharp(p).metadata();
    expect([meta.width, meta.height, meta.bitsPerSample]).toEqual([10, 40, 1]);
  });
});

describe("processPage", () => {
  test.skipIf(!hasTesseract)("autoOrient writes an upright PNG and a thumb <= 300 px", async () => {
    const d = tmpdir();
    const outPath = join(d, "page-001.png");
    const thumbPath = join(d, "thumb-001.jpg");
    const r = await processPage(await pngToPgm(fx("upside-down-text.png")), { mode: "gray", autoOrient: true, outPath, thumbPath });
    expect(r).toEqual({ width: 1120, height: 417, rotation: 180 });
    expect(await detectRotation(outPath)).toBe(0);
    const thumb = await sharp(thumbPath).metadata();
    expect(thumb.format).toBe("jpeg");
    expect(Math.max(thumb.width!, thumb.height!)).toBeLessThanOrEqual(300);
  });

  test("without autoOrient the page is left as scanned", async () => {
    const d = tmpdir();
    const r = await processPage(await pngToPgm(fx("upside-down-text.png")), {
      mode: "gray",
      autoOrient: false,
      outPath: join(d, "p.png"),
      thumbPath: join(d, "t.jpg"),
    });
    expect(r.rotation).toBe(0);
  });

  test("makeThumb keeps small images small", async () => {
    const d = tmpdir();
    const src = join(d, "s.png");
    await sharp({ create: { width: 100, height: 50, channels: 3, background: "#fff" } }).png().toFile(src);
    await makeThumb(src, join(d, "t.jpg"));
    const meta = await sharp(join(d, "t.jpg")).metadata();
    expect([meta.width, meta.height]).toEqual([100, 50]);
  });
});

describe("16-bit colour", () => {
  test.skipIf(!magickAvailable())("16-bit colour PNM becomes a 16-bit PNG", async () => {
    const out = join(tmpdir(), "p16.png");
    expect(await pnmToPng(makePnm16(40, 30, 0x8000), "color", out)).toEqual({ width: 40, height: 30 });
    expect((await sharp(out).metadata()).depth).toBe("ushort");
  });

  test("parsePnmHeader: maxval 65535 for P6 only", () => {
    expect(parsePnmHeader(makePnm16(2, 2)).maxval).toBe(65535);
    expect(parsePnmHeader(makePnm("gray", 2, 2)).maxval).toBe(255);
    expect(() => parsePnmHeader(new TextEncoder().encode("P5\n2 2\n65535\n" + "\0".repeat(8)))).toThrow();
  });
});

describe("device colour profile", () => {
  const existing = fx("upright-text.png"); // any existing file stands in for the profile
  test("DEVICE_ICC wins when the file exists", () => {
    expect(deviceIccPath({ DEVICE_ICC: existing }, "/nope.icm")).toBe(existing);
  });
  test("a directory is not a profile (Docker creates one when the mounted file is missing)", () => {
    const dir = tmpdir();
    expect(deviceIccPath({ DEVICE_ICC: dir }, existing)).toBeNull();
    expect(deviceIccPath({}, dir)).toBeNull();
  });
  test("falls back to the bundled path, else null", () => {
    expect(deviceIccPath({}, existing)).toBe(existing);
    expect(deviceIccPath({}, "/nope.icm")).toBeNull();
    expect(deviceIccPath({ DEVICE_ICC: "/missing.icm" }, existing)).toBeNull();
  });
  test.skipIf(!magickAvailable())("colour pages convert without a device profile", async () => {
    const out = join(tmpdir(), "noicc.png");
    await colorPnmToPng(makePnm("color", 20, 10, 200), out, 8, null);
    expect((await sharp(out).metadata()).width).toBe(20);
  });
});
