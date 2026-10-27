import type { Database } from "bun:sqlite";

export type DedaStatus = "scanning" | "analysing" | "done" | "failed";
export type DedaSource = "scan" | "history";

/** The deda_analyses table. SQL only; rules live in `DedaService`. */
export type DedaRow = {
  id: string;
  name: string;
  status: DedaStatus;
  source: DedaSource;
  scan_id: string | null;
  page: number | null;
  dpi: number | null;
  scanned_at: number;
  analysed_at: number | null;
  found: number | null;
  dots: number | null;
  grid_score: number | null;
  decode: string | null;
  decode_error: string | null;
  error: string | null;
  images: string;
};

export type DedaInsert = Pick<DedaRow, "id" | "name" | "status" | "source" | "scan_id" | "page" | "dpi" | "scanned_at">;
export type DedaUpdate = Partial<Omit<DedaRow, "id" | "source" | "scanned_at">>;

export class DedaRepo {
  constructor(private readonly db: Database) {}

  get(id: string): DedaRow | null {
    return this.db.query<DedaRow, [string]>("SELECT * FROM deda_analyses WHERE id = ?").get(id);
  }

  /** Newest scan first. */
  list(): DedaRow[] {
    return this.db.query<DedaRow, []>("SELECT * FROM deda_analyses ORDER BY scanned_at DESC, rowid DESC").all();
  }

  /** Entries still scanning or analysing. */
  pending(): DedaRow[] {
    return this.db.query<DedaRow, []>("SELECT * FROM deda_analyses WHERE status IN ('scanning', 'analysing')").all();
  }

  insert(row: DedaInsert): void {
    this.db
      .query("INSERT INTO deda_analyses (id, name, status, source, scan_id, page, dpi, scanned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(row.id, row.name, row.status, row.source, row.scan_id, row.page, row.dpi, row.scanned_at);
  }

  update(id: string, fields: DedaUpdate): void {
    const keys = Object.keys(fields) as (keyof DedaUpdate)[];
    if (!keys.length) return;
    this.db
      .query(`UPDATE deda_analyses SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
      .run(...(keys.map((k) => fields[k] ?? null) as (string | number | null)[]), id);
  }

  delete(id: string): boolean {
    return this.db.query("DELETE FROM deda_analyses WHERE id = ?").run(id).changes > 0;
  }

  /** Deletes every entry; returns how many there were. */
  clear(): number {
    return this.db.query("DELETE FROM deda_analyses").run().changes;
  }
}
