export type OutputFormat = "pdf_single" | "pdf_multi" | "png" | "jpeg" | "tiff_single" | "tiff_multi";

export const FORMAT_EXT: Record<OutputFormat, string> = {
  pdf_multi: ".pdf",
  pdf_single: ".pdf",
  png: ".png",
  jpeg: ".jpg",
  tiff_single: ".tif",
  tiff_multi: ".tif",
};

export type NameContext = {
  date: Date;
  outputProfile: string;
  inputProfile: string;
  /** Running scan number. */
  seq: number;
  page?: number;
};

const pad = (n: number, w: number) => String(n).padStart(w, "0");

/** "Archive → Paperless" → "archive-paperless". */
export function slug(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Characters that are invalid in file names on common file systems and shares, plus ';' (smbclient splits commands
 * on it) and '%' (ImageMagick expands it in output names).
 */
const UNSAFE = /[/\\:*?"<>|;%\u0000-\u001f]/g;

/**
 * File name (without extension) from a template. Placeholders: {date} YYYY-MM-DD, {time} HHmm,
 * {datetime} YYYY-MM-DD_HHmmss, {profile} output profile slug, {input} input profile slug, {n} scan number (4 digits),
 * {page} page number (3 digits, empty when not per page). Unknown placeholders stay as written. Uses local time (TZ).
 */
export function renderName(template: string, ctx: NameContext): string {
  const d = ctx.date;
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
  const time = `${pad(d.getHours(), 2)}${pad(d.getMinutes(), 2)}`;
  const values: Record<string, string> = {
    date,
    time,
    datetime: `${date}_${time}${pad(d.getSeconds(), 2)}`,
    profile: slug(ctx.outputProfile),
    input: slug(ctx.inputProfile),
    n: pad(ctx.seq, 4),
    page: ctx.page === undefined ? "" : pad(ctx.page, 3),
  };
  const name = template
    .replace(/\{(\w+)\}/g, (m, key: string) => (key in values ? values[key]! : m))
    .replace(UNSAFE, "")
    .trim();
  return name || "scan";
}

/** Hands out names that are unique within one scan: "scan.png", "scan-2.png", ... */
export class NameSet {
  private used = new Set<string>();
  take(base: string, ext: string): string {
    for (let i = 1; ; i++) {
      const name = `${base}${i === 1 ? "" : `-${i}`}${ext}`;
      if (!this.used.has(name.toLowerCase())) {
        this.used.add(name.toLowerCase());
        return name;
      }
    }
  }
}

/** A template may already end in the extension ("{date}_scan.pdf"). */
export function stripExt(name: string, ext: string): string {
  const exts = ext === ".jpg" ? [".jpg", ".jpeg"] : ext === ".tif" ? [".tif", ".tiff"] : [ext];
  for (const e of exts) if (name.toLowerCase().endsWith(e)) return name.slice(0, -e.length) || "scan";
  return name;
}

/**
 * The file names one delivery produces, in order. pdf_multi / tiff_multi → one file; pdf_single / tiff_single → one
 * file per page (`_001` appended when the template has no {page}); png / jpeg → one image per page. Unique ("-2", "-3").
 * Pure, so the UI shows the same names as an example.
 */
export function outputNames(template: string, format: OutputFormat, ctx: Omit<NameContext, "page">, pageCount = 1): string[] {
  const ext = FORMAT_EXT[format];
  const names = new NameSet();
  if (format === "pdf_multi" || format === "tiff_multi") return [names.take(stripExt(renderName(template, ctx), ext), ext)];
  const single = format === "pdf_single" || format === "tiff_single";
  const out: string[] = [];
  for (let n = 1; n <= pageCount; n++) {
    let base = renderName(template, { ...ctx, page: n });
    if (single && !template.includes("{page}")) base = `${stripExt(base, ext)}_${String(n).padStart(3, "0")}`;
    out.push(names.take(stripExt(base, ext), ext));
  }
  return out;
}
