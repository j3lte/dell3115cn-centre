/**
 * Bun.serve stub of the scanner service API (contract: the API table in scanner-service/README.md).
 * JSON is snake_case, like the real service.
 */
import type { Server } from "bun";
import { gzipSync } from "node:zlib";

export type Mode = "lineart" | "gray" | "color";
export type Reason = "complete" | "feeder_empty" | "jam" | "cancelled" | "error";

export type Scenario = {
  /** Pages the job produces. Default 2. */
  pages?: number;
  /** How the job ends. Default "complete" (or "feeder_empty" when pages is 0 and source is adf). */
  end?: Reason;
  message?: string;
  /** Stop the whole fake service after this many pages were sent and fetched (connection lost mid-scan). */
  dieAfterPages?: number;
  /** Delay before each page event. Default 5 ms. */
  pageDelayMs?: number;
  /** Page size in pixels. Default 120 x 170. */
  width?: number;
  height?: number;
  /** This page's download sends its first bytes and then stalls (the service is still connected, but hangs). */
  stallPage?: number;
  /** Custom page bytes (PNM) per page index (1-based). */
  page?: (n: number, mode: Mode) => Uint8Array;
};

type Page = { n: number; width: number; height: number; mode: Mode; data: Uint8Array };
type Job = {
  id: string;
  body: Record<string, unknown>;
  pages: Page[];
  result: { reason: Reason; message: string; pages: number } | null;
  listeners: Set<() => void>;
  cancelled: boolean;
};

const DPIS = [75, 100, 150, 200, 300, 400, 600];

/** Binary PNM of the given mode filled with `value` (gray level; lineart: 0 = white bit). */
export function makePnm(mode: Mode, width: number, height: number, value = 255): Uint8Array {
  const kind = mode === "lineart" ? "P4" : mode === "gray" ? "P5" : "P6";
  const header = new TextEncoder().encode(mode === "lineart" ? `${kind}\n${width} ${height}\n` : `${kind}\n${width} ${height}\n255\n`);
  let data: Uint8Array;
  if (mode === "lineart") data = new Uint8Array(Math.ceil(width / 8) * height).fill(value >= 128 ? 0 : 0xff);
  else data = new Uint8Array(width * height * (mode === "color" ? 3 : 1)).fill(value);
  const out = new Uint8Array(header.length + data.length);
  out.set(header);
  out.set(data, header.length);
  return out;
}

/** 8-bit colour PNM (P6) of one RGB value, e.g. a sheet of slightly tinted paper. */
export function makeColourPnm(rgb: [number, number, number], width = 120, height = 120): Uint8Array {
  const header = new TextEncoder().encode(`P6\n${width} ${height}\n255\n`);
  const out = new Uint8Array(header.length + width * height * 3);
  out.set(header);
  for (let i = header.length; i < out.length; i += 3) out.set(rgb, i);
  return out;
}

/** 16-bit colour PNM (P6, maxval 65535, big-endian samples) filled with `value16`, as the service sends for depth 16. */
export function makePnm16(width: number, height: number, value16 = 0xffff): Uint8Array {
  const header = new TextEncoder().encode(`P6\n${width} ${height}\n65535\n`);
  const out = new Uint8Array(header.length + width * height * 6);
  out.set(header);
  for (let i = header.length; i < out.length; i += 2) {
    out[i] = value16 >> 8;
    out[i + 1] = value16 & 0xff;
  }
  return out;
}

export class FakeScannerService {
  server: Server<undefined> | null = null;
  port = 0;
  printer: "off" | "idle" | "scanning" | "jammed" = "idle";
  paperInFeeder = false;
  scenario: Scenario = {};
  /** Bodies of every POST /api/scans that was accepted or rejected. */
  requests: Record<string, unknown>[] = [];
  jobs = new Map<string, Job>();
  deleted: string[] = [];
  /** "<job>/<n>" of every page download. */
  fetched = new Set<string>();
  cancelled: string[] = [];
  private statusStreams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private seq = 0;
  private enc = new TextEncoder();

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  start(): this {
    this.server = Bun.serve({ port: this.port, hostname: "127.0.0.1", idleTimeout: 0, fetch: (req) => this.handle(req) });
    this.port = this.server.port!;
    return this;
  }

  stop(): void {
    for (const c of this.statusStreams) {
      try {
        c.error(new Error("stopped"));
      } catch {}
    }
    this.statusStreams.clear();
    for (const job of this.jobs.values()) for (const l of job.listeners) l();
    this.server?.stop(true);
    this.server = null;
  }

  get running(): boolean {
    return this.server !== null;
  }

  status() {
    const running = [...this.jobs.values()].find((j) => !j.result);
    return { service: "scan3115", version: "0.1.0", printer: this.printer, paper_in_feeder: this.paperInFeeder, job: running?.id ?? null };
  }

  setPrinter(printer: FakeScannerService["printer"], paperInFeeder = this.paperInFeeder): void {
    this.printer = printer;
    this.paperInFeeder = paperInFeeder;
    this.publish("status", this.status());
  }

  /** Printer panel Scan → Application → JPEG/TIFF/PDF, as the real service reports it. */
  pressButton(event: { button: number; target?: string; format?: "jpeg" | "tiff" | "pdf" } = { button: 1, target: "application", format: "pdf" }): void {
    this.publish("button", event);
  }

  private publish(event: string, data: unknown): void {
    const chunk = this.enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const c of this.statusStreams) {
      try {
        c.enqueue(chunk);
      } catch {
        this.statusStreams.delete(c);
      }
    }
  }

  private json(status: number, body: unknown): Response {
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    });
  }

  private sse(start: (c: ReadableStreamDefaultController<Uint8Array>) => void | (() => void)): Response {
    let cleanup: void | (() => void);
    const stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        cleanup = start(c);
      },
      cancel: () => {
        if (cleanup) cleanup();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (req.method === "GET" && path === "/api/status") return this.json(200, this.status());
    if (req.method === "GET" && path === "/api/events") {
      return this.sse((c) => {
        this.statusStreams.add(c);
        c.enqueue(this.enc.encode(`event: status\ndata: ${JSON.stringify(this.status())}\n\n`));
        return () => this.statusStreams.delete(c);
      });
    }
    if (req.method === "POST" && path === "/api/scans") return this.startJob(await req.json().catch(() => null));
    const m = path.match(/^\/api\/scans\/([^/]+)(?:\/(events|cancel|pages\/(\d+)))?$/);
    if (!m) return this.json(404, { error: "not_found" });
    const job = this.jobs.get(m[1]!);
    if (!job) return this.json(404, { error: "not_found" });
    const sub = m[2];
    if (!sub && req.method === "GET") {
      return this.json(200, {
        id: job.id,
        state: job.result ? "done" : "running",
        pages: job.pages.map((p) => ({ n: p.n, width: p.width, height: p.height, mode: p.mode, bytes: p.data.length })),
        result: job.result,
      });
    }
    if (!sub && req.method === "DELETE") {
      this.jobs.delete(job.id);
      this.deleted.push(job.id);
      return new Response(null, { status: 204 });
    }
    if (sub === "cancel" && req.method === "POST") {
      job.cancelled = true;
      this.cancelled.push(job.id);
      return new Response(null, { status: 202 });
    }
    if (sub === "events" && req.method === "GET") {
      return this.sse((c) => {
        let sent = 0;
        let closed = false;
        const pump = () => {
          if (closed) return;
          for (; sent < job.pages.length; sent++) {
            const p = job.pages[sent]!;
            c.enqueue(this.enc.encode(`event: page\ndata: ${JSON.stringify({ n: p.n, width: p.width, height: p.height, mode: p.mode })}\n\n`));
          }
          if (job.result) {
            c.enqueue(this.enc.encode(`event: done\ndata: ${JSON.stringify(job.result)}\n\n`));
            closed = true;
            job.listeners.delete(pump);
            c.close();
          } else if (!this.running) {
            closed = true;
            job.listeners.delete(pump);
            try {
              c.error(new Error("service stopped"));
            } catch {}
          }
        };
        job.listeners.add(pump);
        pump();
        return () => {
          closed = true;
          job.listeners.delete(pump);
        };
      });
    }
    if (m[3] && req.method === "GET") {
      const page = job.pages.find((p) => p.n === Number(m[3]));
      if (!page) return this.json(404, { error: "not_found" });
      this.fetched.add(`${job.id}/${page.n}`);
      if (this.scenario.stallPage === page.n) {
        const head = page.data.subarray(0, 16);
        const body = new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(head) }); // never closes
        return new Response(body, { headers: { "content-type": "image/x-portable-anymap" } });
      }
      const gzip = (req.headers.get("accept-encoding") ?? "").includes("gzip");
      return new Response((gzip ? gzipSync(page.data, { level: 1 }) : page.data) as BodyInit, {
        headers: { "content-type": "image/x-portable-anymap", ...(gzip ? { "content-encoding": "gzip" } : {}) },
      });
    }
    return this.json(405, { error: "method_not_allowed" });
  }

  private startJob(body: Record<string, unknown> | null): Response {
    this.requests.push(body ?? {});
    if (!body) return this.json(400, { error: "invalid", message: "body must be JSON" });
    if (body.source !== "flatbed" && body.source !== "adf") return this.json(400, { error: "invalid", message: `unknown source ${body.source}` });
    if (!["lineart", "gray", "color"].includes(body.mode as string)) return this.json(400, { error: "invalid", message: `unknown mode ${body.mode}` });
    if (!DPIS.includes(body.dpi as number)) return this.json(400, { error: "invalid", message: `unsupported dpi ${body.dpi}` });
    if (this.printer === "off") return this.json(503, { error: "printer_off" });
    if ([...this.jobs.values()].some((j) => !j.result)) return this.json(409, { error: "busy" });
    const id = `job${++this.seq}`;
    const job: Job = { id, body, pages: [], result: null, listeners: new Set(), cancelled: false };
    this.jobs.set(id, job);
    void this.run(job, { ...this.scenario });
    return this.json(202, { id });
  }

  private async run(job: Job, s: Scenario): Promise<void> {
    const mode = job.body.mode as Mode;
    const count = s.pages ?? (job.body.source === "flatbed" ? 1 : 2);
    const notify = () => {
      for (const l of [...job.listeners]) l();
    };
    this.printer = "scanning";
    this.publish("status", this.status());
    for (let n = 1; n <= count; n++) {
      await Bun.sleep(s.pageDelayMs ?? 5);
      if (job.cancelled) {
        job.result = { reason: "cancelled", message: "Cancelled", pages: job.pages.length };
        break;
      }
      const width = s.width ?? 120;
      const height = s.height ?? 170;
      const data = s.page ? s.page(n, mode) : job.body.depth === 16 && mode === "color" ? makePnm16(width, height) : makePnm(mode, width, height);
      const dims = parseDims(data);
      job.pages.push({ n, width: dims.width, height: dims.height, mode, data });
      notify();
      if (s.dieAfterPages === n) {
        // let the client receive the page event and download the page (up to 300 ms), then die
        for (let t = 0; t < 30 && !this.fetched.has(`${job.id}/${n}`); t++) await Bun.sleep(10);
        await Bun.sleep(10);
        this.stop();
        return;
      }
    }
    if (!job.result) {
      const pages = job.pages.length;
      let reason: Reason = s.end ?? "complete";
      if (!s.end && pages === 0 && job.body.source === "adf") reason = "feeder_empty";
      const message =
        s.message ??
        (reason === "jam"
          ? `Paper jam after page ${pages} — open and close the ADF cover`
          : reason === "feeder_empty"
            ? "No paper in the feeder"
            : reason === "error"
              ? "printer disconnected"
              : "");
      job.result = { reason, message, pages };
    }
    this.printer = job.result.reason === "jam" ? "jammed" : "idle";
    this.publish("status", this.status());
    notify();
  }
}

function parseDims(pnm: Uint8Array): { width: number; height: number } {
  const text = new TextDecoder().decode(pnm.subarray(0, 64));
  const m = text.match(/^P[456]\s+(?:#.*\s+)*(\d+)\s+(\d+)/);
  return { width: Number(m?.[1] ?? 0), height: Number(m?.[2] ?? 0) };
}
