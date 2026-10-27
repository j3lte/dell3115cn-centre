import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AnalyseFailed, AnalyseUnreachable, type AnalyseClient } from "../analyse-client";
import { ValidationError } from "../destinations/types";
import { DEFAULT_FILTER } from "../pipeline/filters";
import { GLASS_MM } from "../pipeline/region";
import type { DedaRepo, DedaRow, DedaSource, DedaStatus } from "../repos/deda-repo";
import { NotFound } from "./errors";
import { adhocProfile, type AreaMm, type ScanService } from "./scan-service";

export type DedaView = {
  id: string;
  name: string;
  status: DedaStatus;
  source: DedaSource;
  /** The History scan analysed, or (source `scan`) the temporary scan made for it, gone once the analysis ends. */
  scanId: string | null;
  page: number | null;
  dpi: number | null;
  scannedAt: number;
  analysedAt: number | null;
  found: boolean | null;
  dots: number | null;
  gridScore: number | null;
  decode: Record<string, string> | null;
  decodeError: string | null;
  error: string | null;
  images: string[];
};

/** Scans made for an analysis: flatbed, colour, 600 dpi, 8-bit, no auto-orient, no filter. */
const DEDA_INPUT = {
  ...adhocProfile({ source: "flatbed", mode: "color", dpi: 600, depth: 8, autoOrient: false, filter: { ...DEFAULT_FILTER } }),
  name: "DEDA scan",
};
/** An A4 sheet in the glass corner (the glass is 0.2 mm short of A4's 297 mm). */
const A4_AREA: AreaMm = [0, 0, 210, GLASS_MM[1]];
const MIN_DPI = 300;
const NAME_MAX = 100;

/** An expected way for an analysis to fail; its message is the entry's error as is. */
class JobFailed extends Error {}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const pad2 = (n: number) => String(n).padStart(2, "0");

/** `Deda scan YYYY-MM-DD hh:mm:ss` in the server's local time zone. */
export function dedaName(ms: number): string {
  const d = new Date(ms);
  return `Deda scan ${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export type DedaServiceDeps = { repo: DedaRepo; scans: ScanService; analyse: AnalyseClient; dataDir: string; clock?: () => number };

/**
 * Tracking-dot (DEDA) analyses: scans a page for it or takes a stored History page, sends the lossless PNG to the
 * analyse service and keeps the report with its images. Analyses run one at a time.
 */
export class DedaService {
  private readonly repo: DedaRepo;
  private readonly scans: ScanService;
  private readonly analyse: AnalyseClient;
  private readonly root: string;
  private readonly clock: () => number;
  /** Tail of the job queue: one job at a time. */
  private chain: Promise<void> = Promise.resolve();

  constructor(deps: DedaServiceDeps) {
    this.repo = deps.repo;
    this.scans = deps.scans;
    this.analyse = deps.analyse;
    this.root = join(deps.dataDir, "deda");
    this.clock = deps.clock ?? Date.now;
  }

  // ---------------------------------------------------------------- queries

  list(): DedaView[] {
    return this.repo.list().map(view);
  }

  get(id: string): DedaView | null {
    const r = this.repo.get(id);
    return r ? view(r) : null;
  }

  /** An image of an entry, looked up by name in its record (never a path from the request). */
  imagePath(id: string, name: string): string | null {
    const r = this.repo.get(id);
    if (!r || !(JSON.parse(r.images) as string[]).includes(name)) return null;
    const p = join(this.dir(id), `${name}.png`);
    return existsSync(p) ? p : null;
  }

  // ---------------------------------------------------------------- new analyses

  /** Scans page 1 on the flatbed for the analysis; the scan is temporary and deleted when the analysis ends. */
  fromScan(): DedaView {
    const id = Bun.randomUUIDv7();
    const now = this.clock();
    this.repo.insert({ id, name: dedaName(now), status: "scanning", source: "scan", scan_id: null, page: null, dpi: null, scanned_at: now });
    this.enqueue(id, () => this.scanJob(id));
    return this.get(id)!;
  }

  /** Analyses a stored History page: colour, at least 300 dpi. */
  fromHistory(scanId: string, page: number): DedaView {
    const scan = this.scans.get(scanId);
    if (!scan) throw new NotFound("Scan not found");
    const p = this.scans.pagePath(scanId, page);
    if (!p) throw new NotFound(`Page ${page} not found`);
    if (p.mode !== "color") throw new ValidationError("Only colour pages can be analysed for tracking dots");
    if (p.dpi < MIN_DPI) throw new ValidationError(`Pages under ${MIN_DPI} dpi can't be analysed for tracking dots`);
    const id = Bun.randomUUIDv7();
    this.repo.insert({ id, name: dedaName(scan.createdAt), status: "analysing", source: "history", scan_id: scanId, page, dpi: p.dpi, scanned_at: scan.createdAt });
    this.enqueue(id, () => this.analysePage(id, scanId, page));
    return this.get(id)!;
  }

  // ---------------------------------------------------------------- changes

  rename(id: string, name: string): DedaView {
    if (!this.repo.get(id)) throw new NotFound("Analysis not found");
    const n = typeof name === "string" ? name.trim() : "";
    if (n.length < 1 || n.length > NAME_MAX) throw new ValidationError(`Name must be 1 to ${NAME_MAX} characters`);
    this.repo.update(id, { name: n });
    return this.get(id)!;
  }

  /** A running analysis ends without a result; its temporary scan is still deleted. */
  remove(id: string): void {
    if (!this.repo.delete(id)) throw new NotFound("Analysis not found");
    rmSync(this.dir(id), { recursive: true, force: true });
  }

  /** Deletes every entry and its images; returns how many entries there were. */
  clear(): number {
    const n = this.repo.clear();
    rmSync(this.root, { recursive: true, force: true });
    return n;
  }

  /** At startup: nothing survives a restart mid-analysis. Fails pending entries and deletes their temporary scans. */
  recover(): number {
    const pending = this.repo.pending();
    for (const r of pending) {
      this.repo.update(r.id, { status: "failed", error: "Interrupted by a restart" });
      const tempId = r.source === "scan" ? r.scan_id : null;
      if (tempId) this.chain = this.chain.then(() => this.scans.remove(tempId).catch(() => {}));
    }
    return pending.length;
  }

  /** Resolves when the queue is empty (tests). */
  async idle(): Promise<void> {
    for (let c = this.chain; ; c = this.chain) {
      await c;
      if (c === this.chain) return;
    }
  }

  // ---------------------------------------------------------------- jobs

  private dir(id: string): string {
    return join(this.root, id);
  }

  private enqueue(id: string, work: () => Promise<void>): void {
    this.chain = this.chain.then(async () => {
      if (!this.repo.get(id)) return; // removed while queued
      try {
        await work();
      } catch (e) {
        if (!(e instanceof JobFailed || e instanceof AnalyseUnreachable || e instanceof AnalyseFailed)) console.error(`deda ${id}:`, e);
        if (this.repo.get(id)) this.repo.update(id, { status: "failed", error: message(e) });
      }
    });
  }

  private async scanJob(id: string): Promise<void> {
    let tempId: string | null = null;
    try {
      tempId = (await this.scans.startAdhoc(DEDA_INPUT, { areaMm: A4_AREA, store: false, origin: "analyse" })).id;
      this.repo.update(id, { scan_id: tempId });
      await this.scans.settled(tempId);
      const s = this.scans.get(tempId, { includeTemporary: true });
      if (!s || s.status !== "ready" || !s.pages.length) throw new JobFailed(s?.error ?? s?.problem ?? "No page was scanned");
      if (!this.repo.get(id)) return; // removed while scanning
      this.repo.update(id, { status: "analysing", page: 1, dpi: DEDA_INPUT.dpi });
      // The shelf life can be short; the page must not be swept before it is read.
      this.scans.touch(tempId);
      await this.analysePage(id, tempId, 1);
    } finally {
      if (tempId) await this.scans.remove(tempId).catch(() => {});
    }
  }

  private async analysePage(id: string, scanId: string, n: number): Promise<void> {
    const p = this.scans.pagePath(scanId, n);
    if (!p || !existsSync(p.path)) throw new JobFailed("Scan page no longer exists");
    // The stored lossless PNG as is, 16-bit pages too.
    const report = await this.analyse.deda(await Bun.file(p.path).bytes(), p.dpi);
    if (!this.repo.get(id)) return; // removed while analysing
    const images = Object.entries(report.images).filter((e): e is [string, string] => typeof e[1] === "string" && /^[A-Za-z]+$/.test(e[0]));
    mkdirSync(this.dir(id), { recursive: true });
    for (const [name, b64] of images) writeFileSync(join(this.dir(id), `${name}.png`), Buffer.from(b64, "base64"));
    this.repo.update(id, {
      status: "done",
      dpi: p.dpi,
      analysed_at: this.clock(),
      found: report.found ? 1 : 0,
      dots: report.dots,
      grid_score: report.gridScore,
      decode: report.decode ? JSON.stringify(report.decode) : null,
      decode_error: report.decodeError,
      error: null,
      images: JSON.stringify(images.map(([name]) => name)),
    });
  }
}

function view(r: DedaRow): DedaView {
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    source: r.source,
    scanId: r.scan_id,
    page: r.page,
    dpi: r.dpi,
    scannedAt: r.scanned_at,
    analysedAt: r.analysed_at,
    found: r.found === null ? null : r.found === 1,
    dots: r.dots,
    gridScore: r.grid_score,
    decode: r.decode ? (JSON.parse(r.decode) as Record<string, string>) : null,
    decodeError: r.decode_error,
    error: r.error,
    images: JSON.parse(r.images) as string[],
  };
}
