import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DeliveryError, ValidationError } from "../destinations/types";
import type { LiveHub } from "../live";
import { logger } from "../log";
import type { DownloadFile } from "../downloads";
import { encodeOutputs, type OutFile } from "../output/encode";
import { renderName } from "../output/filename";
import { applyFilter, DEFAULT_FILTER, effectiveFilter, isNoopFilter, validateFilter, type Filter } from "../pipeline/filters";
import { LLM_MAX_PX, pageRectToGlass } from "../pipeline/region";
import { rotatePng, type Rotation } from "../pipeline/orient";
import sharp from "sharp";
import { makeThumb, processPage, VIEW_MAX_PX } from "../pipeline/pages";
import { pnmToPng } from "../pipeline/pnm";
import { validateInput, type Dpi, type InputProfile, type Mode, type OutputFormat, type OutputProfile, type Paper, type Source } from "../profiles";
import { JobNotFound, ServiceUnreachable, type ButtonEvent, type JobEvent, type ScanRequest, type ScannerClient } from "../scanner-client";
import { SecretError } from "../secrets";
import type { DeliveryRow, DeliveryStatus, PageRow, ScanOrigin, ScanRepo, ScanRow, ScanStatus } from "../repos/scan-repo";
import type { ProfileService } from "./profile-service";
import type { SettingsService } from "./settings-service";
import type { CalibrationService } from "./calibration-service";
import { NotFound, StateError } from "./errors";

const log = logger("scan");

export type AreaMm = [number, number, number, number];

export type PageView = {
  n: number;
  width: number;
  height: number;
  rotation: number;
  thumbUrl: string;
  /** Large view (long side ≤ 1600 px) with the effective filter, rendered on first request. */
  viewUrl: string;
  filter: Filter | null;
};
export type DeliveryView = {
  id: number;
  outputProfileId: number | null;
  outputProfileName: string;
  status: DeliveryStatus;
  error?: string;
  files: { name: string; url: string }[];
  createdAt: number;
};
export type ScanView = {
  id: string;
  createdAt: number;
  status: ScanStatus;
  review: boolean;
  inputProfile: InputProfile;
  outputProfileId: number | null;
  outputProfileName?: string;
  origin: ScanOrigin;
  /** Assistant scan that is deleted at `expiresAt` unless stored; not shown in History or the review tray. */
  temporary: boolean;
  expiresAt?: number;
  /** Flatbed region the scan was made from (glass mm); absent = whole glass or feeder. */
  area?: AreaMm;
  filter: Filter;
  pages: PageView[];
  problem?: string;
  error?: string;
  deliveries: DeliveryView[];
};

type StoredFile = { name: string; path: string; mime: string };
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** Scan settings an assistant chooses for one scan, instead of (or on top of) an input profile. */
export type AdhocSettings = {
  /** Required unless a base profile supplies them. */
  source?: Source;
  mode?: Mode;
  dpi?: Dpi;
  paper?: Paper;
  autoOrient?: boolean;
  threshold?: number;
  filter?: Filter;
  depth?: 8 | 16;
};

/** The input profile snapshot of an assistant scan: `base` (if any) overridden by `s`, validated like a saved profile. */
export function adhocProfile(s: AdhocSettings, base?: InputProfile): InputProfile {
  const source = (s.source ?? base?.source)!;
  const keepPaper = base && base.source === source ? base.paper : undefined;
  const p: InputProfile = {
    id: 0,
    name: "MCP scan",
    source,
    mode: (s.mode ?? base?.mode)!,
    dpi: (s.dpi ?? base?.dpi)!,
    paper: s.paper ?? keepPaper ?? (source === "flatbed" ? "glass" : "a4"),
    autoOrient: s.autoOrient ?? base?.autoOrient ?? false,
    threshold: s.threshold ?? base?.threshold ?? 128,
    filter: s.filter ? validateFilter(s.filter) : (base?.filter ?? { ...DEFAULT_FILTER }),
    depth: s.depth ?? base?.depth ?? 8,
  };
  validateInput(p);
  return p;
}
const pad3 = (n: number) => String(n).padStart(3, "0");
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type ScanServiceDeps = {
  repo: ScanRepo;
  profiles: ProfileService;
  settings: SettingsService;
  calibration: CalibrationService;
  client: ScannerClient;
  hub: LiveHub;
  dataDir: string;
};

export type ScanServiceOptions = { clock?: () => number };

/**
 * Scan sessions: runs scanner jobs, turns pages into upright PNG originals, keeps the review tray, delivers through
 * output profiles and keeps the history. Every state change is broadcast to the live hub.
 */
export class ScanService {
  private readonly clock: () => number;
  /** scan id → running scanner job id */
  private jobs = new Map<string, string>();
  /** scan id → aborts the running batch locally (cancel when the service no longer knows the job) */
  private batchAborts = new Map<string, AbortController>();
  /** scan id → background work (scan batch and/or delivery) */
  private tasks = new Map<string, Promise<void>>();
  /** scan id → tail of the per-scan operation queue */
  private locks = new Map<string, Promise<unknown>>();

  private readonly repo: ScanRepo;
  private readonly profiles: ProfileService;
  private readonly settings: SettingsService;
  private readonly calibration: CalibrationService;
  private readonly client: ScannerClient;
  private readonly hub: LiveHub;
  private readonly dataDir: string;

  constructor(deps: ScanServiceDeps, opts: ScanServiceOptions = {}) {
    this.repo = deps.repo;
    this.profiles = deps.profiles;
    this.settings = deps.settings;
    this.calibration = deps.calibration;
    this.client = deps.client;
    this.hub = deps.hub;
    this.dataDir = deps.dataDir;
    this.clock = opts.clock ?? Date.now;
    this.recover();
    // Download links live in memory; files exported for links that did not survive a restart are orphans.
    rmSync(join(this.dataDir, "exports"), { recursive: true, force: true });
  }

  /** Nothing survives a restart mid-scan or mid-delivery; never leave such scans looking active. */
  private recover(): void {
    this.repo.recoverInterrupted();
  }

  // ---------------------------------------------------------------- queries

  private row(id: string): ScanRow | null {
    return this.repo.scan(id);
  }

  private mustRow(id: string): ScanRow {
    const r = this.row(id);
    if (!r) throw new NotFound(`Scan ${id} not found`);
    return r;
  }

  private pageRows(id: string): PageRow[] {
    return this.repo.pages(id);
  }

  private abs(rel: string): string {
    return join(this.dataDir, rel);
  }

  private scanDir(id: string): string {
    return join(this.dataDir, "scans", id);
  }

  private thumbFor(pagePath: string): string {
    return pagePath.replace(/page-(\d+)\.png$/, "thumb-$1.jpg");
  }

  private viewFor(pagePath: string): string {
    return pagePath.replace(/page-(\d+)\.png$/, "view-$1.jpg");
  }

  private scanFilter(r: ScanRow): Filter {
    return r.filter ? { ...DEFAULT_FILTER, ...JSON.parse(r.filter) } : { ...DEFAULT_FILTER };
  }

  private view(r: ScanRow): ScanView {
    const pages = this.pageRows(r.id).map((p): PageView => {
      let v = 0;
      try {
        v = Math.round(statSync(this.abs(this.thumbFor(p.path))).mtimeMs);
      } catch {}
      return {
        n: p.n,
        width: p.width,
        height: p.height,
        rotation: p.rotation,
        thumbUrl: `/api/scans/${r.id}/pages/${p.n}/thumb?v=${v}`,
        viewUrl: `/api/scans/${r.id}/pages/${p.n}/view?v=${v}`,
        filter: p.filter ? (JSON.parse(p.filter) as Filter) : null,
      };
    });
    const deliveries = this.repo
      .deliveries(r.id)
      .map((d): DeliveryView => {
        const view: DeliveryView = {
          id: d.id,
          outputProfileId: d.output_profile_id,
          outputProfileName: d.output_profile_name,
          status: d.status,
          files: (JSON.parse(d.files) as StoredFile[]).map((f) => ({
            name: f.name,
            url: `/api/scans/${r.id}/deliveries/${d.id}/files/${encodeURIComponent(f.name)}`,
          })),
          createdAt: d.created_at,
        };
        if (d.error) view.error = d.error;
        return view;
      });
    const v: ScanView = {
      id: r.id,
      createdAt: r.created_at,
      status: r.status,
      review: !!r.review,
      inputProfile: JSON.parse(r.input_profile) as InputProfile,
      outputProfileId: r.output_profile_id,
      origin: r.origin,
      temporary: r.expires_at !== null,
      filter: this.scanFilter(r),
      pages,
      deliveries,
    };
    if (r.expires_at !== null) v.expiresAt = r.expires_at;
    if (r.area) v.area = JSON.parse(r.area) as AreaMm;
    const out = r.output_profile_id === null ? null : this.profiles.findOutput(r.output_profile_id);
    if (out) v.outputProfileName = out.name;
    if (r.problem) v.problem = r.problem;
    if (r.error) v.error = r.error;
    return v;
  }

  /** A scan by id. Temporary (assistant) scans are only returned with `includeTemporary`. */
  get(id: string, opts: { includeTemporary?: boolean } = {}): ScanView | null {
    const r = this.row(id);
    if (!r || (r.expires_at !== null && !opts.includeTemporary)) return null;
    return this.view(r);
  }

  /** Colour pages of at least `minDpi` per stored scan, newest scan first; scans without one are left out. */
  colourPageGroups(minDpi: number, limit: number): { id: string; createdAt: number; pages: { n: number; dpi: number; mode: string }[] }[] {
    const out: { id: string; createdAt: number; pages: { n: number; dpi: number; mode: string }[] }[] = [];
    for (const r of this.repo.colourPages(minDpi, limit)) {
      let g = out.at(-1);
      if (!g || g.id !== r.scan_id) out.push((g = { id: r.scan_id, createdAt: r.created_at, pages: [] }));
      g.pages.push({ n: r.n, dpi: r.dpi, mode: r.mode });
    }
    return out;
  }

  /** Like `get` with temporary scans, but a missing scan is a NotFound that explains temporary scans expire. */
  mustGet(id: string): ScanView {
    this.requireScan(id, { includeTemporary: true });
    return this.get(id, { includeTemporary: true })!;
  }

  /**
   * Throws NotFound when there is no scan `id` as `get` sees it; reads only the scan's row. With `includeTemporary`
   * (assistants) the message explains that temporary scans expire.
   */
  requireScan(id: string, opts: { includeTemporary?: boolean } = {}): void {
    const r = this.row(id);
    if (opts.includeTemporary) {
      if (!r) throw new NotFound(`Scan ${id} not found (temporary scans expire after ${this.shelfLifeMinutes()} minutes)`);
    } else if (!r || r.expires_at !== null) throw new NotFound("Scan not found");
  }

  /** The current view of a scan this service just changed, temporary or not. */
  private current(id: string): ScanView {
    return this.get(id, { includeTemporary: true })!;
  }

  private shelfLifeMinutes(): number {
    return this.settings.read().mcpShelfLifeMinutes;
  }

  /** Newest first; `before` is a createdAt cursor from the previous page. */
  list(limit = 20, before?: number): ScanView[] {
    const rows = this.repo.list(limit, before);
    return rows.map((r) => this.view(r));
  }

  /** What a (re)connecting client needs: scans in progress, every scan in the review tray, and the most recent scan. */
  liveScans(): ScanView[] {
    const rows = this.repo.live();
    return rows.map((r) => this.view(r));
  }

  /** The stored lossless PNG of a page (temporary scans too), with the dpi and mode it was scanned at. */
  pagePath(id: string, n: number): { path: string; dpi: number; mode: PageRow["mode"] } | null {
    const p = this.repo.page(id, n);
    return p ? { path: this.abs(p.path), dpi: p.dpi, mode: p.mode } : null;
  }

  thumbPath(id: string, n: number): string | null {
    const p = this.repo.page(id, n);
    if (!p) return null;
    const t = this.abs(this.thumbFor(p.path));
    return existsSync(t) ? t : null;
  }

  /**
   * Large page view with the effective filter. Cached next to the page; the cache is stale when the thumbnail is newer
   * (thumbnails are re-rendered on every rotate and filter change).
   */
  async pageView(id: string, n: number): Promise<string | null> {
    return this.lock(id, async () => {
      const r = this.row(id);
      const p = this.repo.page(id, n);
      if (!r || !p) return null;
      const view = this.abs(this.viewFor(p.path));
      const mtime = (f: string) => {
        try {
          return statSync(f).mtimeMs;
        } catch {
          return -1;
        }
      };
      if (mtime(view) < 0 || mtime(view) < mtime(this.abs(this.thumbFor(p.path)))) {
        const filter = effectiveFilter(this.scanFilter(r), p.filter ? (JSON.parse(p.filter) as Filter) : null);
        await makeThumb(this.abs(p.path), view, filter, VIEW_MAX_PX);
      }
      return view;
    });
  }

  /** A delivered file, looked up by name in the delivery record (never a path from the request). */
  deliveryFile(id: string, deliveryId: number, name: string): StoredFile | null {
    const d = this.repo.delivery(id, deliveryId);
    if (!d) return null;
    const f = (JSON.parse(d.files) as StoredFile[]).find((x) => x.name === name);
    if (!f) return null;
    const path = this.abs(f.path);
    return existsSync(path) ? { ...f, path } : null;
  }

  // ---------------------------------------------------------------- plumbing

  /** Pushes the scan to the UI; temporary assistant scans stay out of the UI until stored. */
  private broadcast(id: string): void {
    const v = this.get(id);
    if (v) this.hub.broadcast({ type: "scan", scan: v });
  }

  private update(
    id: string,
    fields: Partial<Pick<ScanRow, "status" | "problem" | "error" | "page_count" | "review" | "filter" | "output_profile_id" | "expires_at">>,
  ): void {
    this.repo.updateScan(id, fields);
  }

  /** Runs fn after every earlier operation on the same scan. */
  private lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.locks.set(id, tail);
    void tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return next;
  }

  private track(id: string, work: Promise<void>): void {
    const wrapped: Promise<void> = work
      .catch((e) => {
        // A bug must never leave a scan looking active forever.
        log.error(`${id}:`, e);
        const r = this.row(id);
        if (r && (r.status === "scanning" || r.status === "delivering")) {
          this.update(id, { status: "failed", error: `Internal error: ${message(e)}` });
          this.broadcast(id);
        }
      })
      .finally(() => {
        if (this.tasks.get(id) === wrapped) this.tasks.delete(id);
      });
    this.tasks.set(id, wrapped);
  }

  /** Resolves when no background work (scanning, delivering) is running for the scan. */
  async settled(id: string): Promise<void> {
    for (let t = this.tasks.get(id); t; t = this.tasks.get(id)) await t;
  }

  private editable(r: ScanRow): void {
    if (r.status === "scanning" || r.status === "delivering" || this.jobs.has(r.id)) throw new StateError(`Scan is ${r.status}; wait until it has finished`);
  }

  // ---------------------------------------------------------------- scanning

  private request(input: InputProfile, area: AreaMm | null): ScanRequest {
    const r: ScanRequest = { source: input.source, mode: input.mode, dpi: input.dpi };
    if (input.source === "adf") r.paper = input.paper as ScanRequest["paper"];
    if (area) r.area_mm = area;
    if (input.mode === "lineart") r.threshold = input.threshold;
    if (input.depth === 16) r.depth = 16;
    return r;
  }

  async start(inputId: number, outputId: number, opts: { review: boolean; areaMm?: AreaMm; origin?: "ui" | "button" }): Promise<ScanView> {
    const input = this.profiles.findInput(inputId);
    if (!input) throw new NotFound(`Input profile ${inputId} not found`);
    const output = this.profiles.findOutput(outputId);
    if (!output) throw new NotFound(`Output profile ${outputId} not found`);
    const area = this.checkArea(input, opts.areaMm ?? null);
    // Region scans and flatbed multi-page PDFs always go through the review tray.
    const review = !!opts.review || !!area || (input.source === "flatbed" && output.format === "pdf_multi");
    return this.begin(input, { outputId, review, area, origin: opts.origin ?? "ui", expiresAt: null });
  }

  /**
   * An assistant (MCP) scan with its own settings: no output profile, never delivered unless sent, and temporary
   * (deleted after the shelf life, see `touch`) unless `store`. `origin` "analyse": a scan the DEDA service makes and
   * deletes itself.
   */
  async startAdhoc(input: InputProfile, opts: { areaMm?: AreaMm; store: boolean; origin?: "mcp" | "analyse" }): Promise<ScanView> {
    validateInput(input);
    const area = this.checkArea(input, opts.areaMm ?? null);
    const expiresAt = opts.store ? null : this.clock() + this.shelfLifeMinutes() * MINUTE_MS;
    return this.begin(input, { outputId: null, review: true, area, origin: opts.origin ?? "mcp", expiresAt });
  }

  private checkArea(input: InputProfile, area: AreaMm | null): AreaMm | null {
    if (!area) return null;
    if (!Array.isArray(area) || area.length !== 4 || area.some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0) || area[2] <= 0 || area[3] <= 0)
      throw new ValidationError("areaMm must be [x, y, width, height] in mm");
    if (input.source !== "flatbed") throw new ValidationError("A scan region needs a flatbed input profile");
    return area;
  }

  private async begin(
    input: InputProfile,
    o: { outputId: number | null; review: boolean; area: AreaMm | null; origin: ScanOrigin; expiresAt: number | null },
  ): Promise<ScanView> {
    const jobId = await this.client.startScan(this.request(input, o.area));
    const id = Bun.randomUUIDv7();
    mkdirSync(this.scanDir(id), { recursive: true });
    this.repo.insertScan({
      id,
      created_at: this.clock(),
      input_profile: JSON.stringify(input),
      output_profile_id: o.outputId,
      review: o.review ? 1 : 0,
      filter: JSON.stringify(input.filter ?? DEFAULT_FILTER),
      area: o.area ? JSON.stringify(o.area) : null,
      origin: o.origin,
      expires_at: o.expiresAt,
    });
    this.jobs.set(id, jobId);
    log.info(`${id} started (${o.origin}): ${input.name}, ${input.source} ${input.mode} ${input.dpi} dpi${o.review ? ", review" : ""}`);
    this.track(id, this.runBatch(id, jobId));
    this.broadcast(id);
    return this.current(id);
  }

  /** Makes a temporary assistant scan a normal History entry. */
  store(id: string): ScanView {
    this.mustGet(id);
    this.update(id, { expires_at: null });
    log.info(`${id} kept in History`);
    this.broadcast(id);
    return this.current(id);
  }

  /** A temporary scan lives for the shelf life after its last use. */
  touch(id: string): void {
    const r = this.row(id);
    if (r && r.expires_at !== null) this.update(id, { expires_at: this.clock() + this.shelfLifeMinutes() * MINUTE_MS });
  }

  /** Deletes temporary scans past their expiry that are not scanning or delivering. Returns how many. */
  sweepTemporary(): number {
    const ids = this.repo
      .expiredIds(this.clock())
      .filter((id) => !this.jobs.has(id) && !this.tasks.has(id));
    for (const id of ids) this.deleteNow(id);
    return ids.length;
  }

  /** "Scan more" / "Scan next page": appends a batch to a scan in the review tray. */
  async more(scanId: string): Promise<ScanView> {
    return this.lock(scanId, async () => {
      const r = this.mustRow(scanId);
      if ((r.status !== "review" && r.status !== "ready") || this.jobs.has(scanId)) throw new StateError("Scan more is only possible from the review tray");
      const input = JSON.parse(r.input_profile) as InputProfile;
      const area = r.area ? (JSON.parse(r.area) as AreaMm) : null;
      const jobId = await this.client.startScan(this.request(input, area));
      this.jobs.set(scanId, jobId);
      this.update(scanId, { status: "scanning", error: null });
      log.info(`${scanId} scanning more pages`);
      this.track(scanId, this.runBatch(scanId, jobId));
      this.broadcast(scanId);
      return this.current(scanId);
    });
  }

  private async runBatch(id: string, jobId: string): Promise<void> {
    const input = JSON.parse(this.mustRow(id).input_profile) as InputProfile;
    let received = 0;
    let result: Extract<JobEvent, { type: "done" }> | null = null;
    let lost: string | null = null;
    const failures: string[] = [];
    let chain: Promise<void> = Promise.resolve();
    const abort = new AbortController();
    this.batchAborts.set(id, abort);
    try {
      for await (const ev of this.client.jobEvents(jobId, abort.signal)) {
        if (ev.type === "page") {
          // Download right away (the service may disappear) into a spool file; process in order in the background.
          const spool = join(this.scanDir(id), `incoming-${jobId.replace(/\W/g, "")}-${ev.n}.pnm`);
          await this.client.fetchPageToFile(jobId, ev.n, spool, abort.signal);
          const k = ++received;
          chain = chain.then(() =>
            this.addPage(id, new Uint8Array(readFileSync(spool)), ev.mode ?? input.mode, input)
              .catch((e) => {
                failures.push(`Page ${k} could not be processed: ${message(e)}`);
              })
              .finally(() => rmSync(spool, { force: true })),
          );
        } else {
          result = ev;
        }
      }
    } catch (e) {
      if (abort.signal.aborted) result = { type: "done", reason: "cancelled", message: "Cancelled", pages: received };
      else lost = e instanceof ServiceUnreachable ? "Connection to scanner lost" : `Scan aborted: ${message(e)}`;
    }
    if (this.batchAborts.get(id) === abort) this.batchAborts.delete(id);
    await chain;
    this.jobs.delete(id);
    await this.client.deleteJob(jobId).catch(() => {}); // also after a lost connection: the service may still be up
    await this.finishBatch(id, { received, result, lost, failures });
  }

  private async addPage(id: string, pnm: Uint8Array, mode: PageRow["mode"], input: InputProfile): Promise<void> {
    await this.lock(id, async () => {
      const r = this.row(id);
      if (!r) return; // removed meanwhile
      const existing = this.pageRows(id);
      const k = existing.reduce((m, p) => Math.max(m, Number(p.path.match(/page-(\d+)\.png$/)?.[1] ?? 0)), 0) + 1;
      const pagePath = join(this.scanDir(id), `page-${pad3(k)}.png`);
      const info = await processPage(pnm, {
        mode,
        autoOrient: input.autoOrient,
        outPath: pagePath,
        thumbPath: this.thumbFor(pagePath),
        filter: this.scanFilter(r),
        whiteGains: mode === "color" ? this.calibration.gains(input.source) : undefined,
      });
      const n = existing.length + 1;
      this.repo.insertPage({
        scan_id: id,
        n,
        path: relative(this.dataDir, pagePath),
        width: info.width,
        height: info.height,
        dpi: input.dpi,
        mode,
        rotation: info.rotation,
      });
      this.update(id, { page_count: n });
      this.broadcast(id);
    });
  }

  private async finishBatch(
    id: string,
    b: { received: number; result: Extract<JobEvent, { type: "done" }> | null; lost: string | null; failures: string[] },
  ): Promise<void> {
    const r = this.row(id);
    if (!r) return;
    this.touch(id); // a long batch must not be swept before the assistant has seen it
    const total = this.pageRows(id).length;
    let issue: string | null = null; // what went wrong in this batch
    let cancelled = false;
    if (b.lost) issue = b.received ? `${b.lost} after page ${b.received}` : b.lost;
    else if (!b.result) issue = "Connection to scanner lost";
    else if (b.result.reason === "jam")
      issue = b.received ? b.result.message || `Paper jam after page ${b.received} — open and close the ADF cover` : "Paper jam — open and close the ADF cover";
    else if (b.result.reason === "feeder_empty" && b.received === 0) issue = b.result.message || "No paper in the feeder";
    else if (b.result.reason === "error") issue = `Scanner error${b.received ? ` after page ${b.received}` : ""}: ${b.result.message || "unknown"}`;
    else if (b.result.reason === "cancelled") cancelled = true;
    const issues = [issue, ...b.failures].filter((x): x is string => !!x);

    let problem = r.problem;
    let error: string | null = null;
    // With pages from this batch the issue marks the scan as partial (kept in history); without, it is the error.
    if (b.received > 0 || (r.review && total > 0)) {
      if (issues.length && b.received > 0) problem = [problem, ...issues].filter(Boolean).join("; ");
      else if (issues.length) error = issues.join("; ");
    } else if (issues.length) error = issues.join("; ");

    let status: ScanStatus;
    if (cancelled && !(r.review && total > 0)) status = "cancelled";
    else if (total === 0) {
      status = "failed";
      error = error ?? "No pages were scanned";
    } else if (r.review || cancelled) status = r.origin === "mcp" || r.origin === "analyse" ? "ready" : "review";
    else status = "delivering";
    this.update(id, { status, problem, error, page_count: total });
    if (status === "failed") log.warn(`${id} failed: ${error}`);
    else if (status === "cancelled") log.info(`${id} cancelled`);
    else if (issues.length) log.warn(`${id} scanned ${b.received} page(s), ${status}: ${issues.join("; ")}`);
    else log.info(`${id} scanned ${b.received} page(s), ${status}`);
    this.broadcast(id);
    if (status === "delivering" && r.output_profile_id !== null) await this.deliver(id, r.output_profile_id);
  }

  // ---------------------------------------------------------------- delivery

  /** Callers claim the scan first by setting it to `delivering` under the scan's lock. */
  private async deliver(id: string, outputId: number): Promise<void> {
    await this.lock(id, async () => {
      const r = this.mustRow(id);
      if (r.status !== "delivering") throw new StateError(`Scan is ${r.status}; it can't be delivered now`);
      this.update(id, { error: null });
      const profileRow = this.profiles.findOutput(outputId);
      const name = profileRow?.name ?? `Output profile ${outputId}`;
      const to = `"${name}" (${profileRow?.destination.type ?? "missing"})`;
      const t0 = performance.now();
      const did = this.repo.insertDelivery(id, outputId, name, this.clock());
      this.broadcast(id);
      let files: OutFile[] = [];
      const store = () => JSON.stringify(files.map((f) => ({ name: f.name, path: relative(this.dataDir, f.path), mime: f.mime })));
      try {
        if (!profileRow) throw new DeliveryError(`Output profile ${outputId} no longer exists`);
        const profile = this.profiles.getOutputForUse(outputId);
        const dest = this.profiles.destination(profile.destination.type);
        const cfg = dest.parse(profile.destination.config);
        const input = JSON.parse(r.input_profile) as InputProfile;
        const pages = this.pageRows(id).map((p) => ({
          path: this.abs(p.path),
          dpi: p.dpi,
          mode: p.mode,
          rotation: p.rotation,
          filter: p.filter ? (JSON.parse(p.filter) as Filter) : null,
        }));
        const ctx = { date: new Date(r.created_at), outputProfile: profile.name, inputProfile: input.name, seq: r.seq };
        files = await encodeOutputs(pages, profile, ctx, join(this.scanDir(id), "out", String(did)), this.scanFilter(r));
        this.repo.setDeliveryFiles(did, store());
        await dest.send(files, cfg, { scanId: id, title: renderName(profile.filenameTemplate, ctx) });
        this.repo.markDeliverySent(did);
        this.update(id, { status: "done", error: null });
        log.info(`${id} delivered to ${to}: ${files.length} file(s) in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
      } catch (e) {
        const msg = e instanceof SecretError ? `${name}: stored credentials can't be decrypted — re-enter credentials` : message(e);
        if (e instanceof DeliveryError || e instanceof SecretError || e instanceof ValidationError) log.warn(`${id} delivery to ${to} failed: ${msg}`);
        else log.error(`${id} delivery ${did} to ${to} failed:`, e);
        this.repo.markDeliveryFailed(did, msg, store());
        // A scan that was delivered once stays done; the failed resend shows as its own delivery row.
        const sentBefore = this.repo.hasSentDelivery(id);
        this.update(id, sentBefore ? { status: "done", error: null } : { status: "failed", error: msg });
      }
      this.broadcast(id);
    });
  }

  /** Send a scan from the review tray (optionally to another output profile). */
  async send(scanId: string, outputId?: number): Promise<ScanView> {
    // Check and claim the scan under its lock, so a second Send at the same time gets a conflict.
    const target = await this.lock(scanId, async () => {
      const r = this.mustRow(scanId);
      if ((r.status !== "review" && r.status !== "ready") || this.jobs.has(scanId)) throw new StateError("Only scans in the review tray can be sent");
      if (!this.pageRows(scanId).length) throw new StateError("There are no pages to send");
      const target = outputId ?? r.output_profile_id;
      if (target === null) throw new ValidationError("Choose an output profile");
      if (!this.profiles.outputExists(target)) throw new NotFound(`Output profile ${target} not found`);
      this.update(scanId, { status: "delivering", output_profile_id: target });
      return target;
    });
    const work = this.deliver(scanId, target);
    this.track(scanId, work);
    await work;
    return this.current(scanId);
  }

  /**
   * Deliver a finished scan again, to the same or another output profile (current filters apply). A cancelled scan
   * with pages (e.g. discarded in the review tray) can be sent this way too.
   */
  async resend(scanId: string, outputId: number): Promise<ScanView> {
    await this.lock(scanId, async () => {
      const r = this.mustRow(scanId);
      if (r.status !== "done" && r.status !== "failed" && r.status !== "cancelled") throw new StateError("Only finished or cancelled scans can be resent");
      if (!this.pageRows(scanId).length) throw new StateError("This scan has no pages");
      if (!this.profiles.outputExists(outputId)) throw new NotFound(`Output profile ${outputId} not found`);
      this.update(scanId, { status: "delivering" });
    });
    const work = this.deliver(scanId, outputId);
    this.track(scanId, work);
    await work;
    return this.current(scanId);
  }

  // ---------------------------------------------------------------- review tray

  private async rerenderThumbs(id: string, only?: number): Promise<void> {
    const r = this.mustRow(id);
    const scanFilter = this.scanFilter(r);
    for (const p of this.pageRows(id)) {
      if (only !== undefined && p.n !== only) continue;
      const pageFilter = p.filter ? (JSON.parse(p.filter) as Filter) : null;
      if (only === undefined && pageFilter) continue; // unaffected by a scan filter change
      await makeThumb(this.abs(p.path), this.abs(this.thumbFor(p.path)), effectiveFilter(scanFilter, pageFilter));
    }
  }

  private page(id: string, n: number): PageRow {
    const p = this.repo.page(id, n);
    if (!p) throw new NotFound(`Page ${n} not found`);
    return p;
  }

  /** Rewrites page numbers: `order` lists the current numbers in their new order. */
  private renumber(id: string, order: number[]): void {
    this.repo.renumberPages(id, order);
  }

  async rotate(scanId: string, n: number, degrees: number): Promise<ScanView> {
    if (![90, 180, 270].includes(degrees)) throw new ValidationError("Rotation must be 90, 180 or 270 degrees");
    return this.lock(scanId, async () => {
      this.editable(this.mustRow(scanId));
      const p = this.page(scanId, n);
      await rotatePng(this.abs(p.path), degrees as Rotation);
      const swap = degrees !== 180;
      this.repo.setPageRotation(scanId, n, (p.rotation + degrees) % 360, swap ? p.height : p.width, swap ? p.width : p.height);
      await this.rerenderThumbs(scanId, n);
      log.info(`${scanId} page ${n} rotated ${degrees}°`);
      this.broadcast(scanId);
      return this.current(scanId);
    });
  }

  async removePage(scanId: string, n: number): Promise<ScanView> {
    return this.lock(scanId, async () => {
      this.editable(this.mustRow(scanId));
      const p = this.page(scanId, n);
      const rest = this.pageRows(scanId)
        .map((x) => x.n)
        .filter((x) => x !== n);
      this.repo.deletePage(scanId, n);
      this.renumber(scanId, rest);
      rmSync(this.abs(p.path), { force: true });
      rmSync(this.abs(this.thumbFor(p.path)), { force: true });
      rmSync(this.abs(this.viewFor(p.path)), { force: true });
      log.info(`${scanId} page ${n} removed`);
      this.broadcast(scanId);
      return this.current(scanId);
    });
  }

  async reorder(scanId: string, order: number[]): Promise<ScanView> {
    return this.lock(scanId, async () => {
      this.editable(this.mustRow(scanId));
      const current = this.pageRows(scanId).map((p) => p.n);
      const valid =
        Array.isArray(order) && order.length === current.length && new Set(order).size === order.length && order.every((x) => current.includes(x));
      if (!valid) throw new ValidationError("order must list every page number exactly once");
      this.renumber(scanId, order);
      log.info(`${scanId} pages reordered: ${order.join(", ")}`);
      this.broadcast(scanId);
      return this.current(scanId);
    });
  }

  async setScanFilter(scanId: string, f: Filter): Promise<ScanView> {
    const filter = validateFilter(f);
    return this.lock(scanId, async () => {
      this.editable(this.mustRow(scanId));
      this.update(scanId, { filter: JSON.stringify(filter) });
      await this.rerenderThumbs(scanId);
      log.info(`${scanId} filter changed`);
      this.broadcast(scanId);
      return this.current(scanId);
    });
  }

  async setPageFilter(scanId: string, n: number, f: Filter | null): Promise<ScanView> {
    const filter = f === null ? null : validateFilter(f);
    return this.lock(scanId, async () => {
      this.editable(this.mustRow(scanId));
      this.page(scanId, n);
      this.repo.setPageFilter(scanId, n, filter ? JSON.stringify(filter) : null);
      await this.rerenderThumbs(scanId, n);
      log.info(`${scanId} page ${n} filter ${filter ? "changed" : "reset"}`);
      this.broadcast(scanId);
      return this.current(scanId);
    });
  }

  // ---------------------------------------------------------------- assistant views

  private pageOf(id: string, n: number): { r: ScanRow; p: PageRow; filter: Filter } {
    this.mustGet(id); // a missing temporary scan gets the "expired" explanation
    const r = this.mustRow(id);
    const p = this.page(id, n);
    return { r, p, filter: effectiveFilter(this.scanFilter(r), p.filter ? (JSON.parse(p.filter) as Filter) : null) };
  }

  /** A page as an assistant sees it: JPEG with the effective filter, at most `maxPx` on the long side. */
  async pageImage(id: string, n: number, maxPx = LLM_MAX_PX): Promise<{ jpeg: Buffer; width: number; height: number; widthMm: number; heightMm: number }> {
    this.touch(id);
    const { p, filter } = this.pageOf(id, n);
    // No auto-crop or straighten: the image keeps the stored page's frame, the one zoom and region scans use.
    const view = { ...filter, autoCrop: false, deskew: false };
    const work = mkdtempSync(join(tmpdir(), "scan-llm-"));
    try {
      const out = join(work, "page.jpg");
      await makeThumb(this.abs(p.path), out, view, maxPx);
      const jpeg = readFileSync(out);
      const m = await sharp(jpeg).metadata();
      return { jpeg, width: m.width!, height: m.height!, widthMm: (p.width * 25.4) / p.dpi, heightMm: (p.height * 25.4) / p.dpi };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  /**
   * A region (mm, in the stored page) at full scan resolution with the effective filter, except auto-crop and
   * straighten (they would move the region); downscaled to `maxPx` when larger.
   */
  async zoom(id: string, n: number, rectMm: AreaMm, maxPx = LLM_MAX_PX): Promise<{ jpeg: Buffer; width: number; height: number; pxPerMm: number }> {
    this.touch(id);
    const { p, filter } = this.pageOf(id, n);
    const k = p.dpi / 25.4;
    const left = Math.max(0, Math.round(rectMm[0] * k));
    const top = Math.max(0, Math.round(rectMm[1] * k));
    const width = Math.min(p.width - left, Math.round(rectMm[2] * k));
    const height = Math.min(p.height - top, Math.round(rectMm[3] * k));
    if (!(width > 0 && height > 0)) throw new ValidationError("That area is empty or outside the page");
    const work = mkdtempSync(join(tmpdir(), "scan-zoom-"));
    try {
      let src = join(work, "crop.png");
      await sharp(this.abs(p.path)).extract({ left, top, width, height }).png().toFile(src);
      const f = { ...filter, autoCrop: false, deskew: false };
      if (!isNoopFilter(f)) {
        const filtered = join(work, "filtered.png");
        await applyFilter(src, f, filtered, { dpi: p.dpi, rotation: p.rotation });
        src = filtered;
      }
      const jpeg = await sharp(src).resize(maxPx, maxPx, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer();
      const m = await sharp(jpeg).metadata();
      return { jpeg, width: m.width!, height: m.height!, pxPerMm: (m.width! / width) * k };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  /**
   * Files for an assistant to download: the scan encoded as `format` (like an output profile, without a destination),
   * one page as PNG with its effective filter, or a file of an earlier delivery. New files are written to `outDir` and
   * owned by the caller (the download store deletes them); delivered files are not.
   */
  async exportFiles(
    id: string,
    what: { format: OutputFormat } | { page: number } | { deliveryId: number; name: string },
    outDir: string,
  ): Promise<DownloadFile[]> {
    this.touch(id);
    this.mustGet(id);
    const r = this.mustRow(id);
    if ("deliveryId" in what) {
      const f = this.deliveryFile(id, what.deliveryId, what.name);
      if (!f) throw new NotFound(`File ${what.name} not found in delivery ${what.deliveryId}`);
      return [{ ...f, owned: false }];
    }
    mkdirSync(outDir, { recursive: true });
    try {
      if ("page" in what) {
        const { p, filter } = this.pageOf(id, what.page);
        const path = join(outDir, `page-${pad3(what.page)}.png`);
        await applyFilter(this.abs(p.path), filter, path, { dpi: p.dpi, rotation: p.rotation });
        return [{ path, name: `scan-page-${pad3(what.page)}.png`, mime: "image/png", owned: true }];
      }
      const pages = this.pageRows(id).map((p) => ({
        path: this.abs(p.path),
        dpi: p.dpi,
        mode: p.mode,
        rotation: p.rotation,
        filter: p.filter ? (JSON.parse(p.filter) as Filter) : null,
      }));
      if (!pages.length) throw new StateError("This scan has no pages");
      const profile: OutputProfile = {
        id: 0,
        name: "Download",
        format: what.format,
        jpegQuality: 85,
        filenameTemplate: "scan-{date}_{time}",
        destination: { type: "download", config: {} },
      };
      const ctx = { date: new Date(r.created_at), outputProfile: "download", inputProfile: (JSON.parse(r.input_profile) as InputProfile).name, seq: r.seq };
      const files = await encodeOutputs(pages, profile, ctx, outDir, this.scanFilter(r));
      return files.map((f) => ({ ...f, owned: true }));
    } catch (e) {
      rmSync(outDir, { recursive: true, force: true });
      throw e;
    }
  }

  /** A region of a flatbed page in glass coordinates, for scanning it again (e.g. at a higher resolution). */
  glassArea(id: string, n: number, rectMm: AreaMm): AreaMm {
    this.touch(id);
    const { r, p } = this.pageOf(id, n);
    if ((JSON.parse(r.input_profile) as InputProfile).source !== "flatbed")
      throw new StateError("This page came from the feeder; put it on the glass and use a preview to choose the area");
    const area = r.area ? (JSON.parse(r.area) as AreaMm) : null;
    return pageRectToGlass(rectMm, { widthPx: p.width, heightPx: p.height, dpi: p.dpi, rotation: p.rotation }, area);
  }

  // ---------------------------------------------------------------- cancel / delete / cleanup

  async cancel(scanId: string): Promise<ScanView> {
    const r = this.mustRow(scanId);
    const jobId = this.jobs.get(scanId);
    if (jobId) {
      if (!(await this.cancelJob(scanId, jobId))) await this.settled(scanId);
      return this.current(scanId);
    }
    if (r.status !== "review" && r.status !== "ready") throw new StateError(`A ${r.status} scan can't be cancelled`);
    this.update(scanId, { status: "cancelled" });
    log.info(`${scanId} cancelled`);
    this.broadcast(scanId);
    return this.current(scanId);
  }

  /**
   * Asks the service to cancel the job; true when it accepted (the job's events end the batch). When the service no
   * longer knows the job (404, e.g. it restarted), the batch is ended locally as cancelled and false is returned.
   */
  private async cancelJob(scanId: string, jobId: string): Promise<boolean> {
    try {
      await this.client.cancel(jobId);
      return true;
    } catch (e) {
      if (!(e instanceof JobNotFound)) throw e;
      this.batchAborts.get(scanId)?.abort();
      return false;
    }
  }

  private deleteNow(id: string): void {
    this.repo.deleteScan(id);
    rmSync(this.scanDir(id), { recursive: true, force: true });
  }

  async remove(scanId: string): Promise<void> {
    const temporary = this.mustRow(scanId).expires_at !== null; // assistant and analysis scans: not History
    const jobId = this.jobs.get(scanId);
    if (jobId) await this.cancelJob(scanId, jobId).catch(() => {});
    await this.settled(scanId);
    await this.lock(scanId, async () => this.deleteNow(scanId));
    if (!temporary) log.info(`${scanId} deleted`);
  }

  /** Deletes finished scans older than `days`. Returns how many were removed. */
  cleanup(days: number): number {
    const cutoff = this.clock() - days * DAY_MS;
    const ids = this.repo.idsOlderThan(cutoff).filter((id) => !this.jobs.has(id) && !this.tasks.has(id));
    for (const id of ids) this.deleteNow(id);
    if (ids.length) log.info(`removed ${ids.length} scan(s) older than ${days} days`);
    return ids.length;
  }

  // ---------------------------------------------------------------- printer button

  /** Starts scans from the printer panel (Scan → Application → JPEG/TIFF/PDF). Returns the unsubscribe function. */
  listenToButton(): () => void {
    return this.client.onButton((e) => {
      void this.fromButton(e);
    });
  }

  /**
   * The button's scan: the configured input profile and the output profile for the panel format (falling back to the
   * PDF mapping, then any mapping), no review. Problems go to the UI as a notice, never only to the log.
   */
  async fromButton(e: ButtonEvent): Promise<ScanView | null> {
    const s = this.settings.read();
    const ids = s.buttonOutputProfileIds ?? {};
    const outputId = (e.format ? ids[e.format] : undefined) ?? ids.pdf ?? Object.values(ids).find((v) => typeof v === "number");
    log.info(`printer button pressed (${e.format ?? "no format"})`);
    if (s.buttonInputProfileId === null || outputId === undefined) {
      log.warn("printer button: no default profiles are set");
      this.hub.broadcast({ type: "notice", message: "Printer button pressed, but no default profiles are set" });
      return null;
    }
    try {
      return await this.start(s.buttonInputProfileId, outputId, { review: false, origin: "button" });
    } catch (err) {
      log.warn(`printer button: ${message(err)}`);
      this.hub.broadcast({ type: "notice", message: `Printer button: ${message(err)}` });
      return null;
    }
  }

  // ---------------------------------------------------------------- preview

  /** Quick 75 dpi colour scan of the whole glass, ICC-corrected PNG. Not stored. */
  async preview(): Promise<Uint8Array<ArrayBuffer>> {
    log.info("preview started");
    const t0 = performance.now();
    const jobId = await this.client.startScan({ source: "flatbed", mode: "color", dpi: 75 });
    const work = mkdtempSync(join(tmpdir(), "scan-preview-"));
    try {
      let result: Extract<JobEvent, { type: "done" }> | null = null;
      for await (const ev of this.client.jobEvents(jobId)) if (ev.type === "done") result = ev;
      if (!result || result.pages < 1) throw new StateError(result?.message || "The preview produced no image");
      const out = join(work, "preview.png");
      await pnmToPng(await this.client.fetchPage(jobId, 1), "color", out, { whiteGains: this.calibration.gains("flatbed") });
      log.info(`preview done in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
      return new Uint8Array(readFileSync(out));
    } finally {
      await this.client.deleteJob(jobId).catch(() => {});
      rmSync(work, { recursive: true, force: true });
    }
  }
}
