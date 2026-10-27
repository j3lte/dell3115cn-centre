import type { Database } from "bun:sqlite";
import { SETTING_KEYS, type AppSettings } from "../db";

/** Keys where a stored null is a value ("off", "none"); for the others it falls back to the default. */
const NULLABLE = new Set<keyof AppSettings>(["cleanupDays", "buttonInputProfileId", "mcpKey", "printerWakeHours"]);

/** The `settings` key/value table: one JSON value per `AppSettings` key. SQL only; rules live in `SettingsService`. */
export class SettingsRepo {
  constructor(private readonly db: Database) {}

  read(): AppSettings {
    const out: AppSettings = {
      cleanupDays: null,
      buttonInputProfileId: null,
      buttonOutputProfileIds: {},
      mcpEnabled: true,
      mcpKey: null,
      mcpShelfLifeMinutes: 60,
      whiteBalance: {},
      printerWakeHours: 24,
    };
    for (const k of SETTING_KEYS) {
      const row = this.db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(k);
      if (!row) continue;
      const v = JSON.parse(row.value);
      if (v !== null || NULLABLE.has(k)) (out as Record<string, unknown>)[k] = v;
    }
    return out;
  }

  write(patch: Partial<AppSettings>): AppSettings {
    const q = this.db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
    for (const k of SETTING_KEYS) if (k in patch) q.run(k, JSON.stringify(patch[k] ?? null));
    return this.read();
  }
}
