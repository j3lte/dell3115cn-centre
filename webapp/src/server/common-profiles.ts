import { DEFAULT_FILTER, type Filter } from "./pipeline/filters";
import type { InputProfileDraft, OutputProfile } from "./profiles";

const filter = (f: Partial<Filter>): Filter => ({ ...DEFAULT_FILTER, ...f });

/** Seeded into a new database; "Add common profiles" adds whichever of these (by name) are missing. */
export const COMMON_INPUT_PROFILES: InputProfileDraft[] = [
  { name: "Document (feeder, gray 300)", source: "adf", mode: "gray", dpi: 300, paper: "a4", autoOrient: true, threshold: 128, filter: filter({ preset: "document" }) },
  { name: "Document (flatbed, gray 300)", source: "flatbed", mode: "gray", dpi: 300, paper: "glass", autoOrient: true, threshold: 128, filter: filter({ preset: "document" }) },
  { name: "Colour document (feeder, colour 200)", source: "adf", mode: "color", dpi: 200, paper: "a4", autoOrient: true, threshold: 128, filter: filter({ preset: "document" }) },
  { name: "Text black & white (feeder, 300)", source: "adf", mode: "lineart", dpi: 300, paper: "a4", autoOrient: true, threshold: 128 },
  { name: "Receipt (flatbed, gray 300)", source: "flatbed", mode: "gray", dpi: 300, paper: "glass", autoOrient: true, threshold: 128, filter: filter({ preset: "document", autoCrop: true, deskew: true }) },
  { name: "Photo (flatbed, colour 300)", source: "flatbed", mode: "color", dpi: 300, paper: "glass", autoOrient: false, threshold: 128 },
  { name: "Photo high quality (flatbed, colour 600)", source: "flatbed", mode: "color", dpi: 600, paper: "glass", autoOrient: false, threshold: 128 },
];

const download = { type: "download" as const, config: {} };

export const COMMON_OUTPUT_PROFILES: Omit<OutputProfile, "id">[] = [
  { name: "Download PDF", format: "pdf_multi", jpegQuality: 85, filenameTemplate: "{date}_{time}_scan", destination: download },
  { name: "Download PDF per page", format: "pdf_single", jpegQuality: 85, filenameTemplate: "{date}_{time}_scan_{page}", destination: download },
  { name: "Download JPEG", format: "jpeg", jpegQuality: 85, filenameTemplate: "{date}_{time}_scan_{page}", destination: download },
  { name: "Download PNG", format: "png", jpegQuality: 85, filenameTemplate: "{date}_{time}_scan_{page}", destination: download },
  { name: "Download TIFF", format: "tiff_multi", jpegQuality: 85, filenameTemplate: "{date}_{time}_scan", destination: download },
];
