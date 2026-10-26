import { DESTINATION_TYPES, ValidationError, type DestinationType } from "./destinations/types";
import { validateFilter, type Filter } from "./pipeline/filters";

export { ValidationError } from "./destinations/types";
export type { DestinationType } from "./destinations/types";

export type Source = "flatbed" | "adf";
export type Mode = "lineart" | "gray" | "color";
export type Dpi = 75 | 100 | 150 | 200 | 300 | 400 | 600;
export type Paper = "a4" | "letter" | "legal" | "glass";

export type InputProfile = {
  id: number;
  name: string;
  source: Source;
  mode: Mode;
  dpi: Dpi;
  paper: Paper;
  autoOrient: boolean;
  threshold: number; // 0-255, lineart only
  /** Default filter for one-tap scans and the review tray's starting filter. */
  filter: Filter;
  /** Bits per channel; absent = 8. 16 is colour only (the scanner returns garbled 16-bit gray). */
  depth?: 8 | 16;
};

export type OutputFormat = "pdf_single" | "pdf_multi" | "png" | "jpeg" | "tiff_single" | "tiff_multi";

export type OutputProfile = {
  id: number;
  name: string;
  format: OutputFormat;
  jpegQuality: number;
  filenameTemplate: string;
  destination: { type: DestinationType; config: Record<string, unknown> };
  needsCredentials?: boolean;
};

export type InputProfileDraft = Omit<InputProfile, "id" | "filter"> & { id?: number; filter?: Filter };
export type OutputProfileDraft = Omit<OutputProfile, "id" | "needsCredentials"> & { id?: number; needsCredentials?: boolean };

export const DPIS: Dpi[] = [75, 100, 150, 200, 300, 400, 600];
export const MODES: Mode[] = ["lineart", "gray", "color"];
export const FORMATS: OutputFormat[] = ["pdf_single", "pdf_multi", "png", "jpeg", "tiff_single", "tiff_multi"];
const ADF_PAPERS: Paper[] = ["a4", "letter", "legal"];

export function validateInput(p: InputProfileDraft): void {
  if (typeof p.name !== "string" || !p.name.trim()) throw new ValidationError("Name is required");
  if (p.source !== "flatbed" && p.source !== "adf") throw new ValidationError(`Unknown source: ${p.source}`);
  if (!MODES.includes(p.mode)) throw new ValidationError(`Unknown mode: ${p.mode}`);
  if (!DPIS.includes(p.dpi)) throw new ValidationError(`dpi must be one of ${DPIS.join(", ")}`);
  if (p.source === "flatbed" && p.paper !== "glass") throw new ValidationError("Flatbed profiles use paper size 'glass'");
  if (p.source === "adf" && !ADF_PAPERS.includes(p.paper)) throw new ValidationError("Feeder profiles use A4, Letter or Legal");
  if (!Number.isInteger(p.threshold) || p.threshold < 0 || p.threshold > 255) throw new ValidationError("Threshold must be 0-255");
  if (typeof p.autoOrient !== "boolean") throw new ValidationError("autoOrient must be true or false");
  if (p.filter !== undefined) validateFilter(p.filter);
  if (p.depth !== undefined && p.depth !== 8 && p.depth !== 16) throw new ValidationError("depth must be 8 or 16");
  if (p.depth === 16 && p.mode !== "color") throw new ValidationError("16-bit scans are colour only");
}

export function validateOutput(p: OutputProfileDraft): void {
  if (typeof p.name !== "string" || !p.name.trim()) throw new ValidationError("Name is required");
  if (!FORMATS.includes(p.format)) throw new ValidationError(`Unknown format: ${p.format}`);
  if (!Number.isInteger(p.jpegQuality) || p.jpegQuality < 1 || p.jpegQuality > 100) throw new ValidationError("JPEG quality must be 1-100");
  if (typeof p.filenameTemplate !== "string" || !p.filenameTemplate.trim()) throw new ValidationError("File name template is required");
  if (!p.destination || !DESTINATION_TYPES.includes(p.destination.type)) throw new ValidationError(`Unknown destination: ${p.destination?.type}`);
  if (typeof p.destination.config !== "object" || p.destination.config === null) throw new ValidationError("Destination config must be an object");
}
