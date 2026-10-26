import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFDict } from "pdf-lib";
import sharp from "sharp";
import { readdirSync } from "node:fs";
import { assertWritten, encodeOutputs, withPngDpi, writeMultiTiff } from "../src/server/output/encode";
import { outputNames, renderName, slug } from "../src/server/output/filename";
import { magickAvailable } from "../src/server/pipeline/magick";
import { pnmToPng } from "../src/server/pipeline/pnm";
import type { OutputProfile } from "../src/server/profiles";
import { makePnm, makePnm16 } from "./fake-service";
import { tmpdir } from "./helpers";

const fx = (name: string) => join(import.meta.dir, "fixtures", name);
const date = new Date(2026, 9, 26, 1, 14, 9);
const ctx = { date, outputProfile: "Archive → Paperless", inputProfile: "Document (feeder, gray 300)", seq: 7 };

function profile(format: OutputProfile["format"], filenameTemplate = "{date}_{time}_scan", jpegQuality = 80): OutputProfile {
  return { id: 1, name: "Test", format, jpegQuality, filenameTemplate, destination: { type: "download", config: {} } };
}

/** A4 at 150 dpi, gray, with a little content. */
async function a4Page(dir: string, i: number): Promise<string> {
  const p = join(dir, `page-${i}.png`);
  await sharp({ create: { width: 1240, height: 1754, channels: 3, background: "#ffffff" } })
    .composite([{ input: fx("upright-text.png"), top: 100, left: 60 }])
    .toColourspace("b-w")
    .png()
    .toFile(p);
  return p;
}

/** Image XObjects of a PDF page: { bits, colorSpace, filter }. */
function pageImages(doc: PDFDocument, index: number) {
  const page = doc.getPage(index);
  const xobjects = page.node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
  return xobjects.keys().map((k) => {
    const stream = xobjects.lookup(k) as PDFRawStream;
    const d = stream.dict;
    return {
      bits: (d.lookup(PDFName.of("BitsPerComponent")) as PDFNumber).asNumber(),
      colorSpace: String(d.lookup(PDFName.of("ColorSpace"))),
      filter: String(d.lookup(PDFName.of("Filter"))),
    };
  });
}

describe("renderName", () => {
  test("date and time", () => expect(renderName("{date}_{time}_scan", ctx)).toBe("2026-10-26_0114_scan"));
  test("datetime, n, page, profile, input", () =>
    expect(renderName("{datetime}-{n}-{page}-{profile}-{input}", { ...ctx, page: 3 })).toBe(
      "2026-10-26_011409-0007-003-archive-paperless-document-feeder-gray-300",
    ));
  test("slug", () => expect(slug("Archive → Paperless")).toBe("archive-paperless"));
  test("slug strips accents", () => expect(slug("Één Brief")).toBe("een-brief"));
  test("page empty when undefined", () => expect(renderName("scan{page}", ctx)).toBe("scan"));
  test("unknown placeholders left as-is", () => expect(renderName("{foo}_{date}", ctx)).toBe("{foo}_2026-10-26"));
  test("sanitised", () => expect(renderName(' a/b\\c:d*e?f"g<h>i|j ', ctx)).toBe("abcdefghij"));
  test("never empty", () => expect(renderName("///", ctx)).toBe("scan"));
  test("strips ; and % (smbclient / ImageMagick specials)", () =>
    expect(renderName("Bill; ACME; deltree Archive; x 50%", ctx)).toBe("Bill ACME deltree Archive x 50"));
});

describe("encodeOutputs", () => {
  test("pdf_multi of 3 pages -> 1 file, 3 pages, A4 150 dpi width ~595 pt", async () => {
    const d = tmpdir();
    const pages = await Promise.all([1, 2, 3].map(async (i) => ({ path: await a4Page(d, i), dpi: 150, mode: "gray" as const })));
    const files = await encodeOutputs(pages, profile("pdf_multi"), ctx, join(d, "out"));
    expect(files.map((f) => f.name)).toEqual(["2026-10-26_0114_scan.pdf"]);
    expect(files[0]!.mime).toBe("application/pdf");
    const doc = await PDFDocument.load(readFileSync(files[0]!.path));
    expect(doc.getPageCount()).toBe(3);
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeCloseTo(595.2, 0);
    expect(height).toBeCloseTo(842, 0);
    expect(pageImages(doc, 0)).toEqual([{ bits: 8, colorSpace: "/DeviceGray", filter: "/DCTDecode" }]);
  });

  test("template that already ends in .pdf is not doubled", async () => {
    const d = tmpdir();
    const files = await encodeOutputs([{ path: await a4Page(d, 1), dpi: 150, mode: "gray" }], profile("pdf_multi", "{date}_scan.pdf"), ctx, d);
    expect(files.map((f) => f.name)).toEqual(["2026-10-26_scan.pdf"]);
  });

  test("pdf_single -> one pdf per page with _001.._003", async () => {
    const d = tmpdir();
    const pages = await Promise.all([1, 2, 3].map(async (i) => ({ path: await a4Page(d, i), dpi: 150, mode: "gray" as const })));
    const files = await encodeOutputs(pages, profile("pdf_single"), ctx, join(d, "out"));
    expect(files.map((f) => f.name)).toEqual(["2026-10-26_0114_scan_001.pdf", "2026-10-26_0114_scan_002.pdf", "2026-10-26_0114_scan_003.pdf"]);
    for (const f of files) expect((await PDFDocument.load(readFileSync(f.path))).getPageCount()).toBe(1);
  });

  test("pdf_single honours an explicit {page}", async () => {
    const d = tmpdir();
    const pages = [{ path: await a4Page(d, 1), dpi: 150, mode: "gray" as const }];
    const files = await encodeOutputs(pages, profile("pdf_single", "p{page}-x"), ctx, d);
    expect(files.map((f) => f.name)).toEqual(["p001-x.pdf"]);
  });

  test("lineart pages are embedded as 1-bit images", async () => {
    const d = tmpdir();
    const p = join(d, "l.png");
    await pnmToPng(makePnm("lineart", 1240, 1754, 255), "lineart", p);
    const files = await encodeOutputs([{ path: p, dpi: 150, mode: "lineart" }], profile("pdf_multi"), ctx, d);
    const doc = await PDFDocument.load(readFileSync(files[0]!.path));
    expect(pageImages(doc, 0)).toEqual([{ bits: 1, colorSpace: "/DeviceGray", filter: "/FlateDecode" }]);
    expect(statSync(files[0]!.path).size).toBeLessThan(20000);
  });

  test("colour pages are embedded as RGB JPEG", async () => {
    const d = tmpdir();
    const p = join(d, "c.png");
    await sharp({ create: { width: 300, height: 200, channels: 3, background: "#ff8000" } }).png().toFile(p);
    const files = await encodeOutputs([{ path: p, dpi: 100, mode: "color" }], profile("pdf_multi"), ctx, d);
    const doc = await PDFDocument.load(readFileSync(files[0]!.path));
    expect(pageImages(doc, 0)).toEqual([{ bits: 8, colorSpace: "/DeviceRGB", filter: "/DCTDecode" }]);
  });

  test("jpeg quality applied (smaller at 50 than 90)", async () => {
    const d = tmpdir();
    const page = { path: await a4Page(d, 1), dpi: 150, mode: "gray" as const };
    const [q50] = await encodeOutputs([page], profile("jpeg", "q50", 50), ctx, join(d, "a"));
    const [q90] = await encodeOutputs([page], profile("jpeg", "q90", 90), ctx, join(d, "b"));
    expect(q50!.name).toBe("q50.jpg");
    expect(q50!.mime).toBe("image/jpeg");
    expect(statSync(q50!.path).size).toBeLessThan(statSync(q90!.path).size);
  });

  test("png and jpeg carry the scan resolution (300 dpi page → density 300)", async () => {
    const d = tmpdir();
    const page = { path: await a4Page(d, 1), dpi: 300, mode: "gray" as const };
    for (const format of ["png", "jpeg"] as const) {
      const [f] = await encodeOutputs([page], profile(format), ctx, join(d, format));
      expect([format, (await sharp(f!.path).metadata()).density]).toEqual([format, 300]);
    }
  });

  test("png keeps a 1-bit lineart page 1-bit; an existing resolution is replaced, not duplicated", async () => {
    const d = tmpdir();
    const l = join(d, "l.png");
    await pnmToPng(makePnm("lineart", 800, 600, 0), "lineart", l);
    const [f] = await encodeOutputs([{ path: l, dpi: 200, mode: "lineart" }], profile("png"), ctx, join(d, "out"));
    const meta = await sharp(f!.path).metadata();
    expect([meta.bitsPerSample, meta.density]).toEqual([1, 200]);
    const again = withPngDpi(new Uint8Array(readFileSync(f!.path)), 600);
    expect(Buffer.from(again).toString("latin1").split("pHYs").length - 1).toBe(1);
    expect((await sharp(again).metadata()).density).toBe(600);
  });

  test("test_unique_names_within_scan", async () => {
    const d = tmpdir();
    const pages = await Promise.all([1, 2].map(async (i) => ({ path: await a4Page(d, i), dpi: 150, mode: "gray" as const })));
    const files = await encodeOutputs(pages, profile("png", "scan"), ctx, join(d, "out"));
    expect(files.map((f) => f.name)).toEqual(["scan.png", "scan-2.png"]);
    expect(files.map((f) => basename(f.path))).toEqual(["scan.png", "scan-2.png"]);
    expect(files[0]!.mime).toBe("image/png");
    expect((await sharp(files[1]!.path).metadata()).format).toBe("png");
  });
});

describe("TIFF", () => {
  /** "<compression> <x resolution>" per page, via ImageMagick 7 identify. */
  async function tiffPages(path: string): Promise<string[]> {
    const proc = Bun.spawn(["magick", "identify", "-format", "%C %x\\n", path], { stdout: "pipe" });
    return (await new Response(proc.stdout).text()).trim().split("\n");
  }

  test.skipIf(!magickAvailable())("tiff_multi of 3 pages -> 1 file with 3 pages", async () => {
    const d = tmpdir();
    const pages = await Promise.all([1, 2, 3].map(async (i) => ({ path: await a4Page(d, i), dpi: 150, mode: "gray" as const })));
    const files = await encodeOutputs(pages, profile("tiff_multi"), ctx, join(d, "out"));
    expect(files.map((f) => f.name)).toEqual(["2026-10-26_0114_scan.tif"]);
    expect(files[0]!.mime).toBe("image/tiff");
    expect((await sharp(files[0]!.path, { pages: -1 }).metadata()).pages).toBe(3);
  });

  test.skipIf(!magickAvailable())("tiff_multi with % in the template -> exactly one file with the expected name", async () => {
    for (const template of ["rent 50%", "Invoice %d"]) {
      const d = tmpdir();
      const pages = await Promise.all([1, 2].map(async (i) => ({ path: await a4Page(d, i), dpi: 150, mode: "gray" as const })));
      const out = join(d, "out");
      const files = await encodeOutputs(pages, profile("tiff_multi", template), ctx, out);
      expect(files.map((f) => f.name)).toEqual(outputNames(template, "tiff_multi", ctx));
      expect(readdirSync(out)).toEqual([files[0]!.name]);
      expect((await sharp(files[0]!.path, { pages: -1 }).metadata()).pages).toBe(2);
    }
  });

  test.skipIf(!magickAvailable())("the multi-page TIFF writer takes any file name ('%' is literal, not an ImageMagick escape)", async () => {
    for (const name of ["rent 50%.tif", "Invoice %d.tif", "a[1].tif"]) {
      const d = tmpdir();
      const pages = await Promise.all([1, 2].map(async (i) => ({ path: await a4Page(d, i), dpi: 150, mode: "gray" as const })));
      const out = join(d, "out");
      const work = join(d, "work");
      mkdirSync(out);
      mkdirSync(work);
      await writeMultiTiff(pages, join(out, name), work);
      expect(readdirSync(out)).toEqual([name]);
      expect((await sharp(join(out, name), { pages: -1 }).metadata()).pages).toBe(2);
    }
  });

  test("a delivery whose encoder did not write a file fails instead of claiming success", () => {
    const d = tmpdir();
    writeFileSync(join(d, "a.tif"), "x");
    expect(() => assertWritten([{ name: "a.tif", path: join(d, "a.tif"), mime: "image/tiff" }])).not.toThrow();
    expect(() => assertWritten([{ name: "b.tif", path: join(d, "b.tif"), mime: "image/tiff" }])).toThrow("b.tif");
  });

  test("tiff_single -> 3 .tif files", async () => {
    const d = tmpdir();
    const pages = await Promise.all([1, 2, 3].map(async (i) => ({ path: await a4Page(d, i), dpi: 150, mode: "gray" as const })));
    const files = await encodeOutputs(pages, profile("tiff_single"), ctx, join(d, "out"));
    expect(files.map((f) => f.name)).toEqual(["2026-10-26_0114_scan_001.tif", "2026-10-26_0114_scan_002.tif", "2026-10-26_0114_scan_003.tif"]);
    for (const f of files) {
      expect(f.mime).toBe("image/tiff");
      const meta = await sharp(f.path).metadata();
      expect([meta.format, meta.pages ?? 1, meta.width, meta.density]).toEqual(["tiff", 1, 1240, 150]);
    }
  });

  test.skipIf(!Bun.which("magick"))("lineart is 1-bit CCITT G4, gray LZW, also when mixed in one multi-page TIFF", async () => {
    const d = tmpdir();
    const l = join(d, "l.png");
    await pnmToPng(makePnm("lineart", 800, 600, 0), "lineart", l);
    const c = join(d, "c.png");
    await sharp({ create: { width: 300, height: 200, channels: 3, background: "#ff8000" } }).png().toFile(c);
    const pages = [
      { path: l, dpi: 200, mode: "lineart" },
      { path: await a4Page(d, 1), dpi: 150, mode: "gray" },
      { path: c, dpi: 100, mode: "color" },
    ];
    const [multi] = await encodeOutputs(pages, profile("tiff_multi"), ctx, join(d, "m"));
    expect(await tiffPages(multi!.path)).toEqual(["Group4 200", "LZW 150", "LZW 100"]);
    const singles = await encodeOutputs(pages, profile("tiff_single"), ctx, join(d, "s"));
    expect((await Promise.all(singles.map((f) => tiffPages(f.path)))).flat()).toEqual(["Group4 200", "LZW 150", "LZW 100"]);
    expect((await sharp(singles[0]!.path).metadata()).bitsPerSample).toBe(1);
    expect((await sharp(singles[2]!.path).metadata()).channels).toBe(3);
  });
});

describe("16-bit pages", () => {
  test.skipIf(!magickAvailable())("PNG and TIFF keep 16 bits; JPEG is 8-bit; PDF has the page", async () => {
    const d = tmpdir();
    const src = join(d, "page.png");
    await pnmToPng(makePnm16(80, 60, 0x9000), "color", src);
    const page = { path: src, dpi: 300, mode: "color" };
    const ctx = { date: new Date(0), outputProfile: "o", inputProfile: "i", seq: 1 };
    const enc = async (format: OutputProfile["format"]) => (await encodeOutputs([page], profile(format), ctx, join(d, format)))[0]!.path;
    expect((await sharp(await enc("png")).metadata()).depth).toBe("ushort");
    expect((await sharp(await enc("tiff_single")).metadata()).depth).toBe("ushort");
    expect((await sharp(await enc("tiff_multi")).metadata()).depth).toBe("ushort");
    expect((await sharp(await enc("jpeg")).metadata()).depth).toBe("uchar");
    expect((await PDFDocument.load(readFileSync(await enc("pdf_multi")))).getPageCount()).toBe(1);
  });
});

test.skipIf(!magickAvailable())("16-bit single TIFF with % in the file name is written under that exact name", async () => {
  const d = tmpdir();
  const src = join(d, "page.png");
  await pnmToPng(makePnm16(20, 10, 0x9000), "color", src);
  const ctx = { date: new Date(0), outputProfile: "o", inputProfile: "i", seq: 1 };
  const files = await encodeOutputs([{ path: src, dpi: 300, mode: "color" }], profile("tiff_single", "100% scan"), ctx, join(d, "out"));
  expect(files.map((f) => basename(f.path))).toEqual([basename(files[0]!.path)]);
  expect(readdirSync(join(d, "out")).filter((n) => !n.startsWith("."))).toEqual([basename(files[0]!.path)]);
  expect((await sharp(files[0]!.path).metadata()).depth).toBe("ushort");
});
