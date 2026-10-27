import type { Database } from "bun:sqlite";

/** `ready`: an assistant (MCP) or analyse scan that has been scanned and not delivered; it never sits in the review tray. */
export type ScanStatus = "scanning" | "review" | "ready" | "delivering" | "done" | "failed" | "cancelled";
/** analyse: a temporary scan made for an analysis (Analyse → Tracking dots), deleted when it ends. */
export type ScanOrigin = "ui" | "button" | "mcp" | "analyse";
export type DeliveryStatus = "sending" | "sent" | "failed";

/** The scan, page and delivery tables. SQL only; rules live in `ScanService`. */
export type ScanRow = {
  seq: number;
  id: string;
  created_at: number;
  input_profile: string;
  output_profile_id: number | null;
  status: ScanStatus;
  page_count: number;
  problem: string | null;
  error: string | null;
  review: number;
  filter: string | null;
  area: string | null;
  origin: ScanOrigin;
  expires_at: number | null;
};
export type PageRow = {
  scan_id: string;
  n: number;
  path: string;
  width: number;
  height: number;
  dpi: number;
  mode: "lineart" | "gray" | "color";
  rotation: number;
  filter: string | null;
};
export type DeliveryRow = {
  id: number;
  scan_id: string;
  output_profile_id: number | null;
  output_profile_name: string;
  status: DeliveryStatus;
  error: string | null;
  files: string;
  created_at: number;
};

/** A new scan: always starts `scanning` with no pages. */
export type ScanInsert = Pick<ScanRow, "id" | "created_at" | "input_profile" | "output_profile_id" | "review" | "filter" | "area" | "origin" | "expires_at">;
/** A new page: the filter starts unset (NULL = use the scan filter). */
export type PageInsert = Omit<PageRow, "filter">;
export type ScanUpdate = Partial<Pick<ScanRow, "status" | "problem" | "error" | "page_count" | "review" | "filter" | "output_profile_id" | "expires_at">>;

export class ScanRepo {
  constructor(private readonly db: Database) {}

  /** Nothing survives a restart mid-scan or mid-delivery. */
  recoverInterrupted(): void {
    this.db.transaction(() => {
      this.db
        .query(
          "UPDATE scans SET status = CASE WHEN origin IN ('mcp', 'analyse') THEN 'ready' ELSE 'review' END, review = 1, problem = coalesce(problem || '; ', '') || 'Scan interrupted by a restart' WHERE status = 'scanning' AND page_count > 0",
        )
        .run();
      this.db.query("UPDATE scans SET status = 'failed', error = 'Interrupted by a restart' WHERE status = 'scanning'").run();
      this.db.query("UPDATE scans SET status = 'failed', error = 'Interrupted by a restart' WHERE status = 'delivering'").run();
      this.db.query("UPDATE deliveries SET status = 'failed', error = 'Interrupted by a restart' WHERE status = 'sending'").run();
    })();
  }

  scan(id: string): ScanRow | null {
    return this.db.query<ScanRow, [string]>("SELECT rowid AS seq, * FROM scans WHERE id = ?").get(id);
  }

  pages(scanId: string): PageRow[] {
    return this.db.query<PageRow, [string]>("SELECT * FROM pages WHERE scan_id = ? ORDER BY n").all(scanId);
  }

  page(scanId: string, n: number): PageRow | null {
    return this.db.query<PageRow, [string, number]>("SELECT * FROM pages WHERE scan_id = ? AND n = ?").get(scanId, n);
  }

  deliveries(scanId: string): DeliveryRow[] {
    return this.db.query<DeliveryRow, [string]>("SELECT * FROM deliveries WHERE scan_id = ? ORDER BY id").all(scanId);
  }

  delivery(scanId: string, deliveryId: number): DeliveryRow | null {
    return this.db.query<DeliveryRow, [number, string]>("SELECT * FROM deliveries WHERE id = ? AND scan_id = ?").get(deliveryId, scanId);
  }

  /** Stored scans, newest first; `before` is a createdAt cursor from the previous page. */
  list(limit: number, before?: number): ScanRow[] {
    return before === undefined
      ? this.db
          .query<ScanRow, [number]>("SELECT rowid AS seq, * FROM scans WHERE expires_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?")
          .all(limit)
      : this.db
          .query<ScanRow, [number, number]>(
            "SELECT rowid AS seq, * FROM scans WHERE expires_at IS NULL AND created_at < ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
          )
          .all(before, limit);
  }

  /**
   * Colour pages of at least `minDpi` in the newest `limit` stored scans that have one, scans newest first and pages
   * in order (for the tracking-dot page picker).
   */
  colourPages(minDpi: number, limit: number): (Pick<PageRow, "scan_id" | "n" | "dpi" | "mode"> & { created_at: number })[] {
    return this.db
      .query<Pick<PageRow, "scan_id" | "n" | "dpi" | "mode"> & { created_at: number }, [number, number, number]>(
        `SELECT p.scan_id, p.n, p.dpi, p.mode, s.created_at
         FROM pages p JOIN scans s ON s.id = p.scan_id
         WHERE p.mode = 'color' AND p.dpi >= ? AND p.scan_id IN (
           SELECT s2.id FROM scans s2
           WHERE s2.expires_at IS NULL AND EXISTS (SELECT 1 FROM pages p2 WHERE p2.scan_id = s2.id AND p2.mode = 'color' AND p2.dpi >= ?)
           ORDER BY s2.created_at DESC, s2.rowid DESC LIMIT ?)
         ORDER BY s.created_at DESC, s.rowid DESC, p.n`,
      )
      .all(minDpi, minDpi, limit);
  }

  /** Scans in progress, every scan in the review tray, and the most recent scan. */
  live(): ScanRow[] {
    return this.db
      .query<ScanRow, []>(
        "SELECT rowid AS seq, * FROM scans WHERE expires_at IS NULL AND (status IN ('scanning', 'review', 'delivering') OR id = (SELECT id FROM scans WHERE expires_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1)) ORDER BY created_at, rowid",
      )
      .all();
  }

  insertScan(row: ScanInsert): void {
    this.db
      .query(
        "INSERT INTO scans (id, created_at, input_profile, output_profile_id, status, page_count, review, filter, area, origin, expires_at) VALUES (?, ?, ?, ?, 'scanning', 0, ?, ?, ?, ?, ?)",
      )
      .run(row.id, row.created_at, row.input_profile, row.output_profile_id, row.review, row.filter, row.area, row.origin, row.expires_at);
  }

  updateScan(id: string, fields: ScanUpdate): void {
    const keys = Object.keys(fields) as (keyof ScanUpdate)[];
    if (!keys.length) return;
    this.db
      .query(`UPDATE scans SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
      .run(...(keys.map((k) => fields[k] ?? null) as (string | number | null)[]), id);
  }

  /** Temporary scans past their expiry. */
  expiredIds(now: number): string[] {
    return this.db
      .query<{ id: string }, [number]>("SELECT id FROM scans WHERE expires_at IS NOT NULL AND expires_at < ?")
      .all(now)
      .map((r) => r.id);
  }

  /** Scans created before `cutoff` that are not scanning or delivering. */
  idsOlderThan(cutoff: number): string[] {
    return this.db
      .query<{ id: string }, [number]>("SELECT id FROM scans WHERE created_at < ? AND status NOT IN ('scanning', 'delivering')")
      .all(cutoff)
      .map((r) => r.id);
  }

  insertPage(p: PageInsert): void {
    this.db
      .query("INSERT INTO pages (scan_id, n, path, width, height, dpi, mode, rotation, filter) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)")
      .run(p.scan_id, p.n, p.path, p.width, p.height, p.dpi, p.mode, p.rotation);
  }

  setPageRotation(scanId: string, n: number, rotation: number, width: number, height: number): void {
    this.db.query("UPDATE pages SET rotation = ?, width = ?, height = ? WHERE scan_id = ? AND n = ?").run(rotation, width, height, scanId, n);
  }

  setPageFilter(scanId: string, n: number, filter: string | null): void {
    this.db.query("UPDATE pages SET filter = ? WHERE scan_id = ? AND n = ?").run(filter, scanId, n);
  }

  deletePage(scanId: string, n: number): void {
    this.db.query("DELETE FROM pages WHERE scan_id = ? AND n = ?").run(scanId, n);
  }

  /** Rewrites page numbers: `order` lists the current numbers in their new order; the scan's page count follows. */
  renumberPages(scanId: string, order: number[]): void {
    this.db.transaction(() => {
      this.db.query("UPDATE pages SET n = -n WHERE scan_id = ?").run(scanId);
      order.forEach((old, i) => this.db.query("UPDATE pages SET n = ? WHERE scan_id = ? AND n = ?").run(i + 1, scanId, -old));
      this.updateScan(scanId, { page_count: order.length });
    })();
  }

  insertDelivery(scanId: string, outputProfileId: number, outputProfileName: string, createdAt: number): number {
    return this.db
      .query<{ id: number }, [string, number, string, number]>(
        "INSERT INTO deliveries (scan_id, output_profile_id, output_profile_name, status, files, created_at) VALUES (?, ?, ?, 'sending', '[]', ?) RETURNING id",
      )
      .get(scanId, outputProfileId, outputProfileName, createdAt)!.id;
  }

  setDeliveryFiles(id: number, files: string): void {
    this.db.query("UPDATE deliveries SET files = ? WHERE id = ?").run(files, id);
  }

  markDeliverySent(id: number): void {
    this.db.query("UPDATE deliveries SET status = 'sent' WHERE id = ?").run(id);
  }

  markDeliveryFailed(id: number, error: string, files: string): void {
    this.db.query("UPDATE deliveries SET status = 'failed', error = ?, files = ? WHERE id = ?").run(error, files, id);
  }

  hasSentDelivery(scanId: string): boolean {
    return this.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM deliveries WHERE scan_id = ? AND status = 'sent'").get(scanId)!.n > 0;
  }

  /** Its pages and deliveries go with it (ON DELETE CASCADE). */
  deleteScan(id: string): void {
    this.db.query("DELETE FROM scans WHERE id = ?").run(id);
  }
}
