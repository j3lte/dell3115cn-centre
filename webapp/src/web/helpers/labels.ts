import type { Filter, OutputProfile } from "../types/api";

export const BRAND_NAME = "Dell 3115CN";

export const SOURCE_LABEL = { adf: "Feeder", flatbed: "Flatbed" } as const;
export const MODE_LABEL = { lineart: "Black & white", gray: "Gray", color: "Colour" } as const;
export const PAPER_LABEL = { a4: "A4", letter: "Letter", legal: "Legal", glass: "Full glass" } as const;
export const DPIS = [75, 100, 150, 200, 300, 400, 600] as const;

export const FORMAT_LABEL: Record<OutputProfile["format"], string> = {
  pdf_multi: "One multi-page PDF",
  pdf_single: "Single-page PDFs",
  png: "PNG images",
  jpeg: "JPEG images",
  tiff_multi: "One multi-page TIFF",
  tiff_single: "Single-page TIFFs",
};

export type DestType = OutputProfile["destination"]["type"];
export const DEST_LABEL: Record<DestType, string> = {
  download: "Download",
  folder: "Folder",
  smb: "SMB share",
  ftp: "FTP",
  paperless: "Paperless-ngx",
  papra: "Papra",
  webhook: "Webhook",
};

export const PRESET_LABELS: Record<Filter["preset"], string> = {
  none: "Original",
  document: "Document",
  gray: "Grayscale",
  bw: "Black & white",
};

export const SHARPEN_LABELS: Record<NonNullable<Filter["sharpen"]>, string> = { off: "Off", light: "Light", normal: "Normal" };
