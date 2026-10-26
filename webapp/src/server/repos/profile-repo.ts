import type { Database } from "bun:sqlite";
import { SECRET_FIELDS, SECRET_MASK, ValidationError, type DestinationType } from "../destinations/types";
import { DEFAULT_FILTER, type Filter } from "../pipeline/filters";
import { COMMON_INPUT_PROFILES, COMMON_OUTPUT_PROFILES } from "../common-profiles";
import type { Dpi, InputProfile, InputProfileDraft, Mode, OutputFormat, OutputProfile, OutputProfileDraft, Paper, Source } from "../profiles";
import { SecretError, type SecretBox } from "../secrets";

/** The input and output profile tables. SQL and secret sealing only; rules live in `ProfileService`. */
type InputRow = {
  id: number;
  name: string;
  source: string;
  mode: string;
  dpi: number;
  paper: string;
  auto_orient: number;
  threshold: number;
  filter: string | null;
  depth: number;
};
type OutputRow = {
  id: number;
  name: string;
  format: string;
  jpeg_quality: number;
  filename_template: string;
  destination_type: string;
  destination_config: string;
};

export class ProfileRepo {
  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
  ) {
    this.seed();
  }

  private seed(): void {
    const done = this.db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get("seeded");
    if (done) return;
    this.db.transaction(() => {
      const empty = (t: string) => this.db.query<{ c: number }, []>(`SELECT count(*) AS c FROM ${t}`).get()!.c === 0;
      if (empty("input_profiles")) for (const p of COMMON_INPUT_PROFILES) this.saveInput(p);
      if (empty("output_profiles")) for (const p of COMMON_OUTPUT_PROFILES) this.saveOutput(p);
      this.db.query("INSERT INTO settings (key, value) VALUES ('seeded', '1')").run();
    })();
  }

  /** Add the common profiles whose names are missing. Existing (possibly edited) profiles are left alone. */
  addCommon(): { input: number; output: number } {
    let input = 0;
    let output = 0;
    this.db.transaction(() => {
      const inNames = new Set(this.listInput().map((p) => p.name));
      const outNames = new Set(this.listOutput().map((p) => p.name));
      for (const p of COMMON_INPUT_PROFILES) if (!inNames.has(p.name)) (this.saveInput(p), input++);
      for (const p of COMMON_OUTPUT_PROFILES) if (!outNames.has(p.name)) (this.saveOutput(p), output++);
    })();
    return { input, output };
  }

  // ---- input profiles ----

  private inputFromRow(r: InputRow): InputProfile {
    const p: InputProfile = {
      id: r.id,
      name: r.name,
      source: r.source as Source,
      mode: r.mode as Mode,
      dpi: r.dpi as Dpi,
      paper: r.paper as Paper,
      autoOrient: !!r.auto_orient,
      threshold: r.threshold,
      filter: r.filter ? { ...DEFAULT_FILTER, ...(JSON.parse(r.filter) as Partial<Filter>) } : { ...DEFAULT_FILTER },
    };
    if (r.depth === 16) p.depth = 16;
    return p;
  }

  listInput(): InputProfile[] {
    return this.db.query<InputRow, []>("SELECT * FROM input_profiles ORDER BY id").all().map((r) => this.inputFromRow(r));
  }

  inputExists(id: number): boolean {
    return !!this.db.query("SELECT 1 FROM input_profiles WHERE id = ?").get(id);
  }

  getInput(id: number): InputProfile | null {
    const r = this.db.query<InputRow, [number]>("SELECT * FROM input_profiles WHERE id = ?").get(id);
    return r ? this.inputFromRow(r) : null;
  }

  /** Stores the draft as given (updates when `id` names a row, else inserts). `ProfileService` validates first. */
  saveInput(p: InputProfileDraft): InputProfile {
    const filter = p.filter ?? { ...DEFAULT_FILTER };
    const values = [p.name.trim(), p.source, p.mode, p.dpi, p.paper, p.autoOrient ? 1 : 0, p.threshold, JSON.stringify(filter), p.depth ?? 8] as const;
    let id = p.id;
    if (id !== undefined && this.getInput(id)) {
      this.db
        .query("UPDATE input_profiles SET name=?, source=?, mode=?, dpi=?, paper=?, auto_orient=?, threshold=?, filter=?, depth=? WHERE id=?")
        .run(...values, id);
    } else {
      const r = this.db
        .query<{ id: number }, any[]>(
          "INSERT INTO input_profiles (name, source, mode, dpi, paper, auto_orient, threshold, filter, depth) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id",
        )
        .get(...values)!;
      id = r.id;
    }
    return this.getInput(id)!;
  }

  deleteInput(id: number): void {
    this.db.query("DELETE FROM input_profiles WHERE id = ?").run(id);
  }

  // ---- output profiles ----

  /** Decrypts what it can; undecryptable secrets stay sealed and mark the profile needsCredentials. */
  private outputFromRow(r: OutputRow): OutputProfile {
    const type = r.destination_type as DestinationType;
    const config = JSON.parse(r.destination_config) as Record<string, unknown>;
    let needsCredentials = false;
    for (const f of SECRET_FIELDS[type] ?? []) {
      const v = config[f];
      if (typeof v !== "string" || v === "") continue;
      try {
        config[f] = this.box.open(v);
      } catch (e) {
        if (!(e instanceof SecretError)) throw e;
        needsCredentials = true;
      }
    }
    const p: OutputProfile = {
      id: r.id,
      name: r.name,
      format: r.format as OutputFormat,
      jpegQuality: r.jpeg_quality,
      filenameTemplate: r.filename_template,
      destination: { type, config },
    };
    if (needsCredentials) p.needsCredentials = true;
    return p;
  }

  listOutput(): OutputProfile[] {
    return this.db.query<OutputRow, []>("SELECT * FROM output_profiles ORDER BY id").all().map((r) => this.outputFromRow(r));
  }

  outputExists(id: number): boolean {
    return !!this.db.query("SELECT 1 FROM output_profiles WHERE id = ?").get(id);
  }

  getOutput(id: number): OutputProfile | null {
    const r = this.db.query<OutputRow, [number]>("SELECT * FROM output_profiles WHERE id = ?").get(id);
    return r ? this.outputFromRow(r) : null;
  }

  /** The profile with every secret decrypted. Throws SecretError when a stored secret can't be decrypted. */
  getOutputForUse(id: number): OutputProfile {
    const p = this.getOutput(id);
    if (!p) throw new ValidationError(`Output profile ${id} not found`);
    if (p.needsCredentials) throw new SecretError(`Output profile "${p.name}": re-enter credentials`);
    return p;
  }

  /** Seals secrets; a masked secret keeps the stored one. `ProfileService` validates and guards first. */
  saveOutput(p: OutputProfileDraft): OutputProfile {
    const type = p.destination.type;
    const existingRow =
      p.id !== undefined ? this.db.query<OutputRow, [number]>("SELECT * FROM output_profiles WHERE id = ?").get(p.id) : null;
    const stored: Record<string, unknown> =
      existingRow && existingRow.destination_type === type ? JSON.parse(existingRow.destination_config) : {};
    const config: Record<string, unknown> = { ...p.destination.config };
    for (const f of SECRET_FIELDS[type]) {
      const v = config[f];
      if (v === SECRET_MASK) config[f] = stored[f] ?? "";
      else if (typeof v === "string" && v !== "") config[f] = this.box.seal(v);
      else config[f] = "";
    }
    const values = [p.name.trim(), p.format, p.jpegQuality, p.filenameTemplate, type, JSON.stringify(config)] as const;
    let id = p.id;
    if (existingRow) {
      this.db
        .query(
          "UPDATE output_profiles SET name=?, format=?, jpeg_quality=?, filename_template=?, destination_type=?, destination_config=? WHERE id=?",
        )
        .run(...values, existingRow.id);
    } else {
      id = this.db
        .query<{ id: number }, any[]>(
          "INSERT INTO output_profiles (name, format, jpeg_quality, filename_template, destination_type, destination_config) VALUES (?,?,?,?,?,?) RETURNING id",
        )
        .get(...values)!.id;
    }
    return this.getOutput(id!)!;
  }

  deleteOutput(id: number): void {
    this.db.query("DELETE FROM output_profiles WHERE id = ?").run(id);
  }

  /** Copy safe to send to the UI: secrets become SECRET_MASK when set, "" when unset. */
  toPublic(p: OutputProfile): OutputProfile {
    const config = { ...p.destination.config };
    for (const f of SECRET_FIELDS[p.destination.type] ?? []) {
      const v = config[f];
      config[f] = typeof v === "string" && v !== "" ? SECRET_MASK : "";
    }
    return { ...p, destination: { type: p.destination.type, config } };
  }
}
