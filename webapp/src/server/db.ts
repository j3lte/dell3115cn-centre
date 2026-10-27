import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { WhiteCalibration } from "./pipeline/white";

/**
 * Each entry is one schema version; never edit an applied migration, append a new one. Version 1 is the whole schema
 * as of the first release (earlier development versions were folded into it).
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE input_profiles (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, mode TEXT NOT NULL, dpi INTEGER NOT NULL,
    paper TEXT NOT NULL, auto_orient INTEGER NOT NULL, threshold INTEGER NOT NULL,
    -- filter: JSON; depth: bits per channel (16 = 16-bit colour)
    filter TEXT, depth INTEGER NOT NULL DEFAULT 8
  );
  CREATE TABLE output_profiles (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, format TEXT NOT NULL, jpeg_quality INTEGER NOT NULL,
    filename_template TEXT NOT NULL, destination_type TEXT NOT NULL, destination_config TEXT NOT NULL
  );
  CREATE TABLE scans (
    id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, input_profile TEXT NOT NULL, output_profile_id INTEGER,
    status TEXT NOT NULL, page_count INTEGER NOT NULL DEFAULT 0, problem TEXT, error TEXT, review INTEGER NOT NULL DEFAULT 0,
    -- filter: JSON; area: flatbed region [x,y,w,h] mm, reused by "scan more"; origin: ui, button or mcp;
    -- expires_at: when a temporary (assistant) scan goes, NULL = kept
    filter TEXT, area TEXT, origin TEXT NOT NULL DEFAULT 'ui', expires_at INTEGER
  );
  CREATE TABLE pages (
    scan_id TEXT NOT NULL REFERENCES scans (id) ON DELETE CASCADE, n INTEGER NOT NULL, path TEXT NOT NULL,
    width INTEGER NOT NULL, height INTEGER NOT NULL, dpi INTEGER NOT NULL, mode TEXT NOT NULL,
    rotation INTEGER NOT NULL DEFAULT 0,
    -- filter: JSON; NULL = use the scan filter
    filter TEXT,
    PRIMARY KEY (scan_id, n)
  );
  CREATE TABLE deliveries (
    id INTEGER PRIMARY KEY, scan_id TEXT NOT NULL REFERENCES scans (id) ON DELETE CASCADE, output_profile_id INTEGER,
    output_profile_name TEXT NOT NULL, status TEXT NOT NULL, error TEXT, files TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX scans_created ON scans (created_at);
  CREATE INDEX deliveries_scan ON deliveries (scan_id);
  `,
  `
  CREATE TABLE deda_analyses (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    -- status: scanning, analysing, done or failed; source: scan (a scan made for it) or history (a stored page)
    status TEXT NOT NULL, source TEXT NOT NULL,
    -- scan_id: no FK, the entry outlives the scan (for source scan it is the temporary scan's id)
    scan_id TEXT, page INTEGER, dpi INTEGER, scanned_at INTEGER NOT NULL, analysed_at INTEGER,
    found INTEGER, dots INTEGER, grid_score REAL,
    -- decode: JSON; images: JSON list of image names (files in DATA_DIR/deda/<id>/<name>.png)
    decode TEXT, decode_error TEXT, error TEXT, images TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX deda_scanned ON deda_analyses (scanned_at);
  `,
  `
  -- SFTP host keys trusted on first use, per server (host in lower case).
  CREATE TABLE host_keys (host TEXT NOT NULL, port INTEGER NOT NULL, fingerprint TEXT NOT NULL, first_seen INTEGER NOT NULL, PRIMARY KEY (host, port));
  `,
];

export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.query<{ version: number }, []>("SELECT version FROM schema_version").get();
  let version = row?.version ?? 0;
  if (version > MIGRATIONS.length) {
    db.close();
    throw new Error(
      `${path}: schema version ${version} is not one this app knows (latest ${MIGRATIONS.length}); it was made by another version of the app`,
    );
  }
  if (!row) db.exec("INSERT INTO schema_version (version) VALUES (0)");
  for (; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]!);
      db.query("UPDATE schema_version SET version = ?").run(version + 1);
    })();
  }
  return db;
}

export type ButtonFormat = "jpeg" | "tiff" | "pdf";
export const BUTTON_FORMATS: ButtonFormat[] = ["jpeg", "tiff", "pdf"];

export type AppSettings = {
  cleanupDays: number | null;
  /** Printer Scan button: input profile, and an output profile per panel format (Scan → Application → JPEG/TIFF/PDF). */
  buttonInputProfileId: number | null;
  buttonOutputProfileIds: Partial<Record<ButtonFormat, number>>;
  /** MCP endpoint for AI assistants: on/off, its bearer key (a UUID the app generates) and how long temporary scans live. */
  mcpEnabled: boolean;
  mcpKey: string | null;
  mcpShelfLifeMinutes: number;
  /** White-point calibration per source (Settings → Colour calibration); a missing source is not corrected. */
  whiteBalance: Partial<Record<"flatbed" | "adf", WhiteCalibration>>;
  /** Opening the app wakes the printer to read its state when the last read is older than this; null = never. */
  printerWakeHours: number | null;
};

export const SETTING_KEYS: (keyof AppSettings)[] = [
  "cleanupDays",
  "buttonInputProfileId",
  "buttonOutputProfileIds",
  "mcpEnabled",
  "mcpKey",
  "mcpShelfLifeMinutes",
  "whiteBalance",
  "printerWakeHours",
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(s: unknown): s is string {
  return typeof s === "string" && UUID_RE.test(s);
}
