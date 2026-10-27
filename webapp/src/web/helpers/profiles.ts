import { outputNames, renderName } from "../../server/output/filename";
import type { InputProfile, InputProfileDraft, OutputProfile, OutputProfileDraft } from "../types/api";
import { DEFAULT_FILTER } from "./filter";
import { DEST_LABEL, FORMAT_LABEL, MODE_LABEL, PAPER_LABEL, SOURCE_LABEL, type DestType } from "./labels";

export type FieldSpec = {
  key: string;
  label: string;
  kind?: "text" | "url" | "number" | "secret" | "bool";
  /** A secret pasted as several lines (a private key). */
  multiline?: boolean;
  hint?: string;
  placeholder?: string;
};
/** Form fields per destination (the server validates; see src/server/destinations). */
export const DEST_FIELDS: Record<DestType, FieldSpec[]> = {
  download: [],
  folder: [{ key: "path", label: "Folder path", placeholder: "/export/scans", hint: "A path inside the container. Mount it as a volume; it must already exist." }],
  sftp: [
    { key: "host", label: "Host", placeholder: "nas.local" },
    { key: "port", label: "Port", kind: "number", placeholder: "22" },
    { key: "path", label: "Folder", placeholder: "scans/inbox", hint: "Relative to the login folder, or absolute. Empty: the login folder." },
    { key: "username", label: "User name" },
    { key: "password", label: "Password", kind: "secret", hint: "A password or a private key (or both)." },
    {
      key: "privateKey",
      label: "Private key",
      kind: "secret",
      multiline: true,
      placeholder: "-----BEGIN OPENSSH PRIVATE KEY-----",
      hint: "Paste the whole key file. Its public key goes in the server's authorized_keys.",
    },
    { key: "passphrase", label: "Passphrase", kind: "secret", hint: "Only for a key that has one." },
  ],
  ftp: [
    { key: "host", label: "Host", placeholder: "ftp.example.org" },
    { key: "port", label: "Port", kind: "number", placeholder: "21" },
    { key: "path", label: "Path", placeholder: "/scans" },
    { key: "username", label: "User name", placeholder: "anonymous" },
    { key: "password", label: "Password", kind: "secret" },
    { key: "secure", label: "Use FTPS (TLS)", kind: "bool" },
  ],
  paperless: [
    { key: "url", label: "Paperless URL", kind: "url", placeholder: "http://paperless:8000" },
    { key: "token", label: "API token", kind: "secret" },
    { key: "tags", label: "Tag ids", placeholder: "1, 4", hint: "Optional, comma-separated." },
    { key: "correspondent", label: "Correspondent id", placeholder: "7", hint: "Optional." },
  ],
  papra: [
    { key: "url", label: "Papra URL", kind: "url", placeholder: "http://papra:1221" },
    { key: "apiKey", label: "API key", kind: "secret" },
    { key: "organizationId", label: "Organisation id" },
  ],
  webhook: [
    { key: "url", label: "Webhook URL", kind: "url", placeholder: "http://automation:5678/webhook/scan" },
    { key: "headerName", label: "Header name", placeholder: "Authorization", hint: "Optional, sent with every request." },
    { key: "headerValue", label: "Header value", kind: "secret" },
  ],
  smb: [],
};

/** A destination's name; a retired one (see `useFeatures`) says it is no longer supported. */
export function destLabel(type: DestType, retired: Record<string, string>): string {
  return retired[type] ? `${DEST_LABEL[type]} (no longer supported)` : DEST_LABEL[type];
}

/** The destination picker: retired types only for a profile that still uses one. */
export function destOptions(current: DestType, retired: Record<string, string>): (readonly [DestType, string])[] {
  return (Object.keys(DEST_LABEL) as DestType[]).filter((t) => t === current || !retired[t]).map((t) => [t, destLabel(t, retired)] as const);
}

export const NEW_INPUT: InputProfileDraft = { name: "", source: "adf", mode: "gray", dpi: 300, paper: "a4", autoOrient: true, threshold: 128, filter: DEFAULT_FILTER };
export const NEW_OUTPUT: OutputProfileDraft = { name: "", format: "pdf_multi", jpegQuality: 85, filenameTemplate: "{date}_{time}_scan", destination: { type: "download", config: {} } };

export function inputSummary(p: InputProfile): string {
  return `${SOURCE_LABEL[p.source]} · ${MODE_LABEL[p.mode]} · ${p.dpi} dpi${p.source === "adf" ? ` · ${PAPER_LABEL[p.paper]}` : ""}${p.depth === 16 ? " · 16-bit" : ""}`;
}

export function outputSummary(p: OutputProfile): string {
  return `${FORMAT_LABEL[p.format]} → ${DEST_LABEL[p.destination.type]}`;
}

/** Example file names for an output profile being edited: the first two of a two-page scan. */
export function filenameExamples(template: string, format: OutputProfileDraft["format"], name: string, date: Date): string[] {
  try {
    return outputNames(template || "scan", format, { date, outputProfile: name || "profile", inputProfile: "input", seq: 1 }, 2);
  } catch {
    return [renderName(template, { date, outputProfile: name, inputProfile: "input", seq: 1 })];
  }
}

/** Changing the mode keeps 16 bits only for colour (the scanner's 16-bit gray is garbled). */
export function withMode(d: Pick<InputProfileDraft, "depth">, mode: InputProfileDraft["mode"]): Pick<InputProfileDraft, "mode" | "depth"> {
  return { mode, depth: mode === "color" ? d.depth : undefined };
}

export const MASK = "••••";
