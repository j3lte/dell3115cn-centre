import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { concatTransformationMatrix, drawObject, PDFDocument, popGraphicsState, pushGraphicsState, type PDFPage } from "pdf-lib";
import sharp from "sharp";
import { runMagick } from "../pipeline/magick";
import { applyFilter, DEFAULT_FILTER, effectiveFilter, isNoopFilter, type Filter } from "../pipeline/filters";
import type { OutputProfile } from "../profiles";
import { outputNames, type NameContext } from "./filename";

export type OutFile = { name: string; path: string; mime: string };

/** `filter` is the per-page override (null/absent = use the scan filter). */
export type PageInput = { path: string; dpi: number; mode: string; rotation?: number; filter?: Filter | null };

const MIME: Record<OutputProfile["format"], string> = {
  pdf_multi: "application/pdf",
  pdf_single: "application/pdf",
  png: "image/png",
  jpeg: "image/jpeg",
  tiff_single: "image/tiff",
  tiff_multi: "image/tiff",
};

type Kind = "bilevel" | "gray" | "rgb";

async function kindOf(path: string): Promise<Kind> {
  const meta = await sharp(path).metadata();
  if (meta.bitsPerSample === 1) return "bilevel";
  return (meta.channels ?? 3) <= 2 ? "gray" : "rgb";
}

/** Page image → JPEG bytes (gray stays single-channel), with the scan resolution in the JFIF header. */
async function toJpeg(path: string, kind: Kind, quality: number, dpi: number): Promise<Buffer> {
  let img = sharp(path).flatten({ background: "#ffffff" });
  if (kind !== "rgb") img = img.toColourspace("b-w");
  return img.withDensity(dpi > 0 ? dpi : 300).jpeg({ quality, mozjpeg: false }).toBuffer();
}

/**
 * The PNG with its pHYs chunk (resolution) set to `dpi`, everything else byte for byte unchanged (bit depth, ICC).
 * Any existing pHYs chunk is replaced.
 */
export function withPngDpi(png: Uint8Array, dpi: number): Uint8Array {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: Uint8Array[] = [png.subarray(0, 8)];
  const ppm = Math.round((dpi > 0 ? dpi : 300) / 0.0254);
  const phys = new Uint8Array(21);
  const pv = new DataView(phys.buffer);
  pv.setUint32(0, 9);
  phys.set(new TextEncoder().encode("pHYs"), 4);
  pv.setUint32(8, ppm);
  pv.setUint32(12, ppm);
  phys[16] = 1; // unit: metre
  pv.setUint32(17, Bun.hash.crc32(phys.subarray(4, 17)));
  for (let at = 8; at + 12 <= png.length; ) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const end = at + 12 + len;
    if (type !== "pHYs") chunks.push(png.subarray(at, end));
    if (type === "IHDR") chunks.push(phys);
    at = end;
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** 1-bit packed rows for a DeviceGray image (1 = white). */
async function packBits(path: string): Promise<{ data: Uint8Array; width: number; height: number }> {
  const { data, info } = await sharp(path).flatten({ background: "#ffffff" }).toColourspace("b-w").raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const rowBytes = Math.ceil(width / 8);
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) if (data[(y * width + x) * channels]! >= 128) out[y * rowBytes + (x >> 3)]! |= 0x80 >> (x & 7);
  return { data: out, width, height };
}

async function addPdfPage(doc: PDFDocument, page: PageInput, quality: number): Promise<void> {
  const kind = await kindOf(page.path);
  const meta = await sharp(page.path).metadata();
  const dpi = page.dpi > 0 ? page.dpi : 300;
  const w = ((meta.width ?? 1) / dpi) * 72;
  const h = ((meta.height ?? 1) / dpi) * 72;
  const pdfPage: PDFPage = doc.addPage([w, h]);
  if (kind === "bilevel") {
    const bits = await packBits(page.path);
    const ref = doc.context.register(
      doc.context.flateStream(bits.data, {
        Type: "XObject",
        Subtype: "Image",
        Width: bits.width,
        Height: bits.height,
        ColorSpace: "DeviceGray",
        BitsPerComponent: 1,
      }),
    );
    const name = pdfPage.node.newXObject("Im", ref);
    pdfPage.pushOperators(pushGraphicsState(), concatTransformationMatrix(w, 0, 0, h, 0, 0), drawObject(name), popGraphicsState());
  } else {
    const img = await doc.embedJpg(await toJpeg(page.path, kind, quality, dpi));
    pdfPage.drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
}

/**
 * One-page TIFF: lineart as 1-bit CCITT G4, gray/colour LZW, with the scan resolution. 16-bit pages go through
 * ImageMagick, because libvips writes 8-bit TIFF only.
 */
async function writeTiff(page: PageInput, path: string): Promise<void> {
  const kind = await kindOf(page.path);
  if ((await sharp(page.path).metadata()).depth === "ushort") {
    const dpi = String(page.dpi > 0 ? page.dpi : 300);
    await runMagick([page.path, "-compress", "LZW", "-units", "PixelsPerInch", "-density", dpi, `TIFF:${path}`]);
    return;
  }
  const res = (page.dpi > 0 ? page.dpi : 300) / 25.4; // pixels per mm
  let img = sharp(page.path).flatten({ background: "#ffffff" });
  if (kind === "bilevel") img = img.toColourspace("b-w").threshold(128).tiff({ compression: "ccittfax4", bitdepth: 1, xres: res, yres: res });
  else img = (kind === "gray" ? img.toColourspace("b-w") : img).tiff({ compression: "lzw", xres: res, yres: res });
  await img.toFile(path);
}

/**
 * Multi-page TIFF. libvips can only join pages of equal size, so each page is written as its own TIFF (with its own
 * compression) and ImageMagick joins them; tiff:preserve-compression keeps G4 for lineart and LZW for the rest
 * (IM6 keeps it by default, IM7 needs the define). ImageMagick expands '%' (and more) in output names, so it writes
 * to a fixed name in `work` and the result is moved into place.
 */
export async function writeMultiTiff(pages: PageInput[], path: string, work: string): Promise<void> {
  const parts: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const part = join(work, `part-${String(i + 1).padStart(3, "0")}.tif`);
    await writeTiff(pages[i]!, part);
    parts.push(part);
  }
  if (parts.length === 1) {
    await Bun.write(path, Bun.file(parts[0]!));
    return;
  }
  const joined = join(work, "joined.tif");
  await runMagick([...parts, "-define", "tiff:preserve-compression=true", "-adjoin", `TIFF:${joined}`]);
  renameSync(joined, path);
}

/** Every output file must exist; a missing one fails the delivery instead of reporting success. */
export function assertWritten(files: OutFile[]): void {
  const missing = files.filter((f) => !existsSync(f.path)).map((f) => f.name);
  if (missing.length) throw new Error(`Output file${missing.length > 1 ? "s" : ""} not written: ${missing.join(", ")}`);
}

async function writePdf(pages: PageInput[], quality: number, path: string): Promise<void> {
  const doc = await PDFDocument.create();
  doc.setProducer("scan-webapp");
  doc.setCreator("scan-webapp");
  for (const p of pages) await addPdfPage(doc, p, quality);
  await Bun.write(path, await doc.save());
}

/**
 * Builds the output files of one delivery from the page PNGs, in page order.
 * pdf_multi / tiff_multi → one file; pdf_single / tiff_single → one file per page (`_001` appended when the
 * template has no {page}); png / jpeg → one image per page. Names are unique within the call ("-2", "-3").
 */
export async function encodeOutputs(
  pages: PageInput[],
  profile: OutputProfile,
  ctx: Omit<NameContext, "page">,
  outDir: string,
  scanFilter: Filter = DEFAULT_FILTER,
): Promise<OutFile[]> {
  mkdirSync(outDir, { recursive: true });
  const work = mkdtempSync(join(outDir, ".work-"));
  try {
    const filtered: PageInput[] = [];
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i]!;
      const f = effectiveFilter(scanFilter, page.filter ?? null);
      if (isNoopFilter(f)) filtered.push(page);
      else {
        const path = join(work, `page-${String(i + 1).padStart(3, "0")}.png`);
        await applyFilter(page.path, f, path, { dpi: page.dpi, rotation: page.rotation ?? 0 });
        filtered.push({ ...page, path });
      }
    }
    const files = await encodeFiltered(filtered, profile, ctx, outDir, work);
    assertWritten(files);
    return files;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function encodeFiltered(
  pages: PageInput[],
  profile: OutputProfile,
  ctx: Omit<NameContext, "page">,
  outDir: string,
  work: string,
): Promise<OutFile[]> {
  const mime = MIME[profile.format];
  const names = outputNames(profile.filenameTemplate, profile.format, ctx, pages.length);
  const files: OutFile[] = names.map((name) => ({ name, path: join(outDir, name), mime }));

  if (profile.format === "pdf_multi") {
    await writePdf(pages, profile.jpegQuality, files[0]!.path);
    return files;
  }
  if (profile.format === "tiff_multi") {
    await writeMultiTiff(pages, files[0]!.path, work);
    return files;
  }
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!;
    const f = files[i]!;
    if (profile.format === "pdf_single") await writePdf([page], profile.jpegQuality, f.path);
    else if (profile.format === "tiff_single") await writeTiff(page, f.path);
    else if (profile.format === "png") await Bun.write(f.path, withPngDpi(new Uint8Array(await Bun.file(page.path).arrayBuffer()), page.dpi));
    else await Bun.write(f.path, await toJpeg(page.path, await kindOf(page.path), profile.jpegQuality, page.dpi));
  }
  return files;
}
