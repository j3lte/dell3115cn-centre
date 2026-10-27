/**
 * Client for the scanner service (contract: the API table in scanner-service/README.md).
 * Keeps a live SSE connection to /api/events for status, reconnecting with backoff.
 */
import { rmSync } from "node:fs";
import { logger } from "./log";

export type ScannerStatus = {
  service: "connecting" | "connected" | "unreachable";
  printer: "off" | "idle" | "scanning" | "jammed" | null;
  paperInFeeder: boolean;
  error?: string;
};

export type ScanRequest = {
  source: "flatbed" | "adf";
  mode: "lineart" | "gray" | "color";
  dpi: number;
  area_mm?: [number, number, number, number];
  paper?: "a4" | "letter" | "legal";
  threshold?: number;
  /** 16 bits per channel (colour only); omitted for 8. */
  depth?: 16;
};

/** Printer panel button press, e.g. Scan → Application → TIFF: `{ button: 1, target: "application", format: "tiff" }`. */
export type ButtonEvent = { button: number; target?: string; format?: "jpeg" | "tiff" | "pdf" };

export type JobReason = "complete" | "feeder_empty" | "jam" | "cancelled" | "error";
export type JobEvent =
  | { type: "page"; n: number; width: number; height: number; mode: "lineart" | "gray" | "color" }
  | { type: "done"; reason: JobReason; message: string; pages: number };

export class ScannerBusy extends Error {
  constructor(message = "The scanner is busy with another scan") {
    super(message);
    this.name = "ScannerBusy";
  }
}
export class PrinterOff extends Error {
  constructor(message = "The printer is off") {
    super(message);
    this.name = "PrinterOff";
  }
}
export class InvalidScan extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidScan";
  }
}
export class ServiceUnreachable extends Error {
  constructor(message = "Can't reach the scanner service") {
    super(message);
    this.name = "ServiceUnreachable";
  }
}
export class JobNotFound extends Error {
  constructor(id: string) {
    super(`Scan job ${id} not found on the scanner service`);
    this.name = "JobNotFound";
  }
}

export type ScannerClientOptions = {
  /** Waits between reconnect attempts; the last value repeats. */
  backoffMs?: number[];
  /** Give up on a connection attempt that has not answered within this time. */
  connectTimeoutMs?: number;
  /** The service pings every 15 s; a status stream silent for longer than this is treated as lost. */
  idleTimeoutMs?: number;
  /** Timeout for plain requests (start, cancel, delete). */
  requestTimeoutMs?: number;
  /** A page download that receives no data for this long is aborted (the service hangs or the network is gone). */
  pageIdleTimeoutMs?: number;
};

type SseEvent = { event: string; data: string };

/** Minimal text/event-stream parser over a fetch body. `onActivity` fires for every chunk, comments included. */
export async function* readSse(body: ReadableStream<Uint8Array>, onActivity?: () => void): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buf = "";
  let event = "message";
  let data: string[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    onActivity?.();
    buf += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.search(/\r?\n/)) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(buf[idx] === "\r" ? idx + 2 : idx + 1);
      if (line === "") {
        if (data.length) yield { event, data: data.join("\n") };
        event = "message";
        data = [];
      } else if (line.startsWith(":")) {
        // comment / ping
      } else {
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
    }
  }
}

const log = logger("scanner");

const INITIAL: ScannerStatus = { service: "connecting", printer: null, paperInFeeder: false };

export class ScannerClient {
  status: ScannerStatus = { ...INITIAL };
  private readonly base: string;
  private readonly backoff: number[];
  private readonly connectTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly pageIdleTimeoutMs: number;
  private statusListeners = new Set<(s: ScannerStatus) => void>();
  private buttonListeners = new Set<(e: ButtonEvent) => void>();
  private running = false;
  private abort: AbortController | null = null;
  private wake: (() => void) | null = null;
  /** The service state last written to the log: reconnect attempts don't repeat it. */
  private loggedService: ScannerStatus["service"] = "connecting";

  constructor(baseUrl: string, opts: ScannerClientOptions = {}) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.backoff = opts.backoffMs?.length ? opts.backoffMs : [1000, 2000, 5000, 10000];
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 5000;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 40000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10000;
    this.pageIdleTimeoutMs = opts.pageIdleTimeoutMs ?? 40000;
  }

  onStatus(cb: (s: ScannerStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  onButton(cb: (event: ButtonEvent) => void): () => void {
    this.buttonListeners.add(cb);
    return () => this.buttonListeners.delete(cb);
  }

  private setStatus(next: ScannerStatus): void {
    const prev = this.status;
    if (
      prev.service === next.service &&
      prev.printer === next.printer &&
      prev.paperInFeeder === next.paperInFeeder &&
      prev.error === next.error
    )
      return;
    this.status = next;
    this.logStatus(prev, next);
    for (const cb of [...this.statusListeners]) {
      try {
        cb(next);
      } catch (e) {
        log.error("status listener failed:", e);
      }
    }
  }

  /** Service up/down once per change, and printer state changes other than starting or ending a scan. */
  private logStatus(prev: ScannerStatus, next: ScannerStatus): void {
    if (next.service === "connecting") return;
    if (next.service !== this.loggedService) {
      this.loggedService = next.service;
      if (next.service === "connected") log.info(`service connected, printer ${next.printer ?? "unknown"}`);
      else log.warn(`service unreachable: ${next.error ?? "no answer"}`);
      return;
    }
    const pair = new Set([prev.printer, next.printer]);
    if (next.service !== "connected" || prev.printer === next.printer || (pair.has("idle") && pair.has("scanning"))) return;
    (next.printer === "jammed" ? log.warn : log.info)(`printer ${next.printer ?? "unknown"}`);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
    this.wake?.();
  }

  /** Retry now instead of waiting for the next backoff step (the UI's Connect button). */
  reconnectNow(): void {
    if (this.wake) {
      this.setStatus({ ...this.status, service: "connecting", error: undefined });
      this.wake();
    }
  }

  private async loop(): Promise<void> {
    let attempt = 0;
    while (this.running) {
      const ctrl = new AbortController();
      this.abort = ctrl;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = (ms: number) => {
        clearTimeout(timer);
        timer = setTimeout(() => ctrl.abort(new Error("No answer from the scanner service")), ms);
      };
      try {
        arm(this.connectTimeoutMs);
        const res = await fetch(`${this.base}/api/events`, { signal: ctrl.signal, headers: { accept: "text/event-stream" } });
        if (!res.ok || !res.body) throw new Error(`Scanner service answered ${res.status}`);
        arm(this.idleTimeoutMs);
        for await (const ev of readSse(res.body, () => arm(this.idleTimeoutMs))) {
          if (ev.event === "status") {
            const s = JSON.parse(ev.data) as { printer?: ScannerStatus["printer"]; paper_in_feeder?: boolean };
            attempt = 0;
            this.setStatus({ service: "connected", printer: s.printer ?? null, paperInFeeder: !!s.paper_in_feeder });
          } else if (ev.event === "button") {
            const raw = JSON.parse(ev.data) as { button?: unknown; target?: unknown; format?: unknown };
            const e: ButtonEvent = { button: Number(raw.button) };
            if (typeof raw.target === "string") e.target = raw.target;
            if (raw.format === "jpeg" || raw.format === "tiff" || raw.format === "pdf") e.format = raw.format;
            for (const cb of [...this.buttonListeners]) cb(e);
          }
        }
        throw new Error("Scanner service closed the connection");
      } catch (e) {
        if (!this.running) break;
        const reason = ctrl.signal.aborted && ctrl.signal.reason instanceof Error ? ctrl.signal.reason.message : errorText(e);
        this.setStatus({ service: "unreachable", printer: null, paperInFeeder: false, error: reason });
      } finally {
        clearTimeout(timer);
        ctrl.abort();
      }
      const wait = this.backoff[Math.min(attempt, this.backoff.length - 1)]!;
      attempt++;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, wait);
        this.wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this.wake = null;
    }
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetch(`${this.base}${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(this.requestTimeoutMs) });
    } catch (e) {
      throw new ServiceUnreachable(`Can't reach the scanner service: ${errorText(e)}`);
    }
  }

  async startScan(req: ScanRequest): Promise<string> {
    const res = await this.request("/api/scans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string; message?: string };
    if (res.status === 202 && body.id) return body.id;
    if (res.status === 409) throw new ScannerBusy();
    if (res.status === 503) throw new PrinterOff();
    if (res.status === 400) throw new InvalidScan(body.message || "Invalid scan parameters");
    throw new Error(`Scanner service answered ${res.status}${body.message ? `: ${body.message}` : ""}`);
  }

  /**
   * Page and done events of a job (history replayed by the service). Throws ServiceUnreachable when the connection
   * drops (or the status stream goes unreachable, or `signal` aborts) before `done`.
   */
  async *jobEvents(id: string, signal?: AbortSignal): AsyncGenerator<JobEvent> {
    const ctrl = new AbortController();
    const off = this.onStatus((s) => {
      if (s.service === "unreachable") ctrl.abort();
    });
    const stop = () => ctrl.abort();
    signal?.addEventListener("abort", stop);
    if (signal?.aborted) ctrl.abort();
    try {
      let res: Response;
      try {
        res = await fetch(`${this.base}/api/scans/${encodeURIComponent(id)}/events`, {
          signal: ctrl.signal,
          headers: { accept: "text/event-stream" },
        });
      } catch (e) {
        throw new ServiceUnreachable(`Can't reach the scanner service: ${errorText(e)}`);
      }
      if (res.status === 404) throw new JobNotFound(id);
      if (!res.ok || !res.body) throw new ServiceUnreachable(`Scanner service answered ${res.status}`);
      try {
        for await (const ev of readSse(res.body)) {
          if (ev.event === "page") {
            const p = JSON.parse(ev.data);
            yield { type: "page", n: p.n, width: p.width, height: p.height, mode: p.mode };
          } else if (ev.event === "done") {
            const d = JSON.parse(ev.data);
            yield { type: "done", reason: d.reason, message: d.message ?? "", pages: d.pages };
            return;
          }
        }
      } catch (e) {
        throw new ServiceUnreachable(`Connection to the scanner service lost: ${errorText(e)}`);
      }
      throw new ServiceUnreachable("Connection to the scanner service lost");
    } finally {
      off();
      signal?.removeEventListener("abort", stop);
      ctrl.abort();
    }
  }

  /** PNM bytes of one page, in memory (small pages, e.g. a preview). See streamPage. */
  async fetchPage(id: string, n: number, signal?: AbortSignal): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    const size = await this.streamPage(id, n, (c) => void chunks.push(c), signal);
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }

  /**
   * One page written to `path` as it arrives, so pages waiting to be processed sit on disk, not in memory (a 600 dpi
   * colour page is about 100 MB). Returns the size; a partial file is removed when the download fails.
   */
  async fetchPageToFile(id: string, n: number, path: string, signal?: AbortSignal): Promise<number> {
    const out = Bun.file(path).writer();
    try {
      const size = await this.streamPage(id, n, (c) => void out.write(c), signal);
      await out.end();
      return size;
    } catch (e) {
      await Promise.resolve(out.end()).catch(() => {});
      rmSync(path, { force: true });
      throw e;
    }
  }

  /**
   * Streams the PNM bytes of one page to `sink` (the service may gzip; fetch decompresses) and returns the size.
   * Throws ServiceUnreachable when no data arrives for `pageIdleTimeoutMs`, the status stream goes unreachable or
   * `signal` aborts.
   */
  private async streamPage(id: string, n: number, sink: (chunk: Uint8Array) => void, signal?: AbortSignal): Promise<number> {
    const ctrl = new AbortController();
    let idle: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => ctrl.abort(new Error(`no data for ${Math.round(this.pageIdleTimeoutMs / 1000)} s`)), this.pageIdleTimeoutMs);
    };
    const stop = () => ctrl.abort(new Error("aborted"));
    signal?.addEventListener("abort", stop);
    if (signal?.aborted) stop();
    const off = this.onStatus((s) => {
      if (s.service === "unreachable") ctrl.abort(new Error("scanner service unreachable"));
    });
    const why = (e: unknown) => (ctrl.signal.aborted && ctrl.signal.reason instanceof Error ? ctrl.signal.reason.message : errorText(e));
    arm();
    try {
      let res: Response;
      try {
        res = await fetch(`${this.base}/api/scans/${encodeURIComponent(id)}/pages/${n}`, { headers: { "accept-encoding": "gzip" }, signal: ctrl.signal });
      } catch (e) {
        throw new ServiceUnreachable(`Can't reach the scanner service: ${why(e)}`);
      }
      if (res.status === 404) throw new JobNotFound(id);
      if (!res.ok) throw new Error(`Scanner service answered ${res.status} for page ${n}`);
      try {
        let size = 0;
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          arm();
          sink(chunk);
          size += chunk.length;
        }
        return size;
      } catch (e) {
        throw new ServiceUnreachable(`Connection lost while downloading page ${n}: ${why(e)}`);
      }
    } finally {
      clearTimeout(idle);
      off();
      signal?.removeEventListener("abort", stop);
      ctrl.abort();
    }
  }

  async cancel(id: string): Promise<void> {
    const res = await this.request(`/api/scans/${encodeURIComponent(id)}/cancel`, { method: "POST" });
    if (res.status === 404) throw new JobNotFound(id);
  }

  async deleteJob(id: string): Promise<void> {
    const res = await this.request(`/api/scans/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.status === 404) throw new JobNotFound(id);
  }
}

function errorText(e: unknown): string {
  if (e instanceof Error) return (e as Error & { code?: string }).code ? `${e.message} (${(e as any).code})` : e.message;
  return String(e);
}
