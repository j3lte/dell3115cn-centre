import { BUTTON_FORMATS, isUuid, type AppSettings, type ButtonFormat } from "../db";
import { ValidationError } from "../destinations/types";
import type { WhiteCalibration } from "../pipeline/white";
import type { Source } from "../profiles";
import type { SettingsRepo } from "../repos/settings-repo";
import { NotFound } from "./errors";

const SHELF_LIFE_MINUTES = { min: 5, max: 1440 } as const;
const WAKE_HOURS = { min: 1, max: 720 } as const;

/** The settings as the Settings page sees them: also says whether the app secret was generated (and shows it then). */
export type SettingsView = AppSettings & { secretGenerated: boolean; generatedSecret?: string };

function intOrNull(v: unknown, label: string): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n)) throw new ValidationError(`${label} must be an integer`);
  return n;
}

export class SettingsService {
  constructor(
    private readonly repo: SettingsRepo,
    private readonly profiles: { inputExists(id: number): boolean; outputExists(id: number): boolean },
    private readonly secret: { secret: string; generated: boolean },
    /** Called after MCP is switched on/off or its key is regenerated (outstanding download links must die). */
    private readonly onMcpChange?: () => void,
  ) {}

  read(): AppSettings {
    return this.repo.read();
  }

  view(): SettingsView {
    return { ...this.read(), secretGenerated: this.secret.generated, ...(this.secret.generated ? { generatedSecret: this.secret.secret } : {}) };
  }

  /**
   * Validates a settings patch (the Settings page's PUT body) and stores it. Unknown keys are ignored. The MCP fields
   * (on/off, shelf life) are only accepted with `allowMcp`: assistants may change the other settings, not their own access.
   */
  update(b: Record<string, unknown>, opts: { allowMcp: boolean }): AppSettings {
    const before = this.read();
    const patch: Partial<AppSettings> = {};
    if ("cleanupDays" in b) {
      const d = intOrNull(b.cleanupDays, "cleanupDays");
      if (d !== null && d < 1) throw new ValidationError("cleanupDays must be at least 1 (or null for off)");
      patch.cleanupDays = d;
    }
    if ("buttonInputProfileId" in b) {
      const id = intOrNull(b.buttonInputProfileId, "buttonInputProfileId");
      if (id !== null && !this.profiles.inputExists(id)) throw new NotFound("Input profile not found");
      patch.buttonInputProfileId = id;
    }
    if ("buttonOutputProfileIds" in b) {
      // Partial update per panel format; null clears that format.
      const given = b.buttonOutputProfileIds ?? {};
      if (typeof given !== "object" || Array.isArray(given)) throw new ValidationError("buttonOutputProfileIds must be an object");
      const ids = { ...before.buttonOutputProfileIds };
      for (const [format, v] of Object.entries(given)) {
        if (!BUTTON_FORMATS.includes(format as ButtonFormat)) throw new ValidationError(`Unknown panel format: ${format} (use jpeg, tiff or pdf)`);
        const id = intOrNull(v, `buttonOutputProfileIds.${format}`);
        if (id !== null && !this.profiles.outputExists(id)) throw new NotFound("Output profile not found");
        if (id === null) delete ids[format as ButtonFormat];
        else ids[format as ButtonFormat] = id;
      }
      patch.buttonOutputProfileIds = ids;
    }
    if ("printerWakeHours" in b) {
      const v = b.printerWakeHours;
      const h = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
      if (h !== null && (typeof h !== "number" || !Number.isInteger(h) || h < WAKE_HOURS.min || h > WAKE_HOURS.max))
        throw new ValidationError(`printerWakeHours must be ${WAKE_HOURS.min}-${WAKE_HOURS.max} hours (or null for never)`);
      patch.printerWakeHours = h;
    }
    if (opts.allowMcp && "mcpEnabled" in b) {
      if (typeof b.mcpEnabled !== "boolean") throw new ValidationError("mcpEnabled must be true or false");
      patch.mcpEnabled = b.mcpEnabled;
    }
    if (opts.allowMcp && "mcpShelfLifeMinutes" in b) {
      const m = intOrNull(b.mcpShelfLifeMinutes, "mcpShelfLifeMinutes");
      if (m === null || m < SHELF_LIFE_MINUTES.min || m > SHELF_LIFE_MINUTES.max)
        throw new ValidationError(`mcpShelfLifeMinutes must be ${SHELF_LIFE_MINUTES.min}-${SHELF_LIFE_MINUTES.max}`);
      patch.mcpShelfLifeMinutes = m;
    }
    const after = this.repo.write(patch);
    if (after.mcpEnabled !== before.mcpEnabled) this.onMcpChange?.();
    return after;
  }

  /** First start: generate the MCP key and enable MCP. Later starts keep what is stored. */
  ensureMcpKey(): AppSettings {
    const s = this.read();
    if (isUuid(s.mcpKey)) return s;
    return this.repo.write({ mcpKey: crypto.randomUUID(), mcpEnabled: true });
  }

  regenerateMcpKey(): AppSettings {
    const s = this.repo.write({ mcpKey: crypto.randomUUID() });
    this.onMcpChange?.();
    return s;
  }

  /** Stores (or, with null, removes) the white-point calibration of one source. */
  setWhiteBalance(source: Source, cal: WhiteCalibration | null): void {
    const wb = { ...this.read().whiteBalance };
    if (cal) wb[source] = cal;
    else delete wb[source];
    this.repo.write({ whiteBalance: wb });
  }
}
