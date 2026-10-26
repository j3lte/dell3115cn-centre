import {
  getJobAttributesRequest,
  getPrinterAttributesRequest,
  jobAttributes,
  parseIpp,
  printerAttributes,
  printJobRequest,
  type IppAttributes,
  type IppMessage,
} from "./ipp";

/** One toner, the belt unit or the fuser, as CUPS reports it (the backend's marker-* attributes, see cups/README.md). */
export type Supply = { name: string; color: string; type: string; level: number | null; low: boolean };
/**
 * What the CUPS queue knows about the printer: supply levels, the alerts our backend reported (covers, trays, error
 * codes, low supplies; `severity` "error" when printing is blocked) and the lifetime page count.
 */
export type PrinterView = {
  supplies: Supply[];
  alerts: string[];
  severity: "error" | "warning" | null;
  pageCount: number | null;
  checkedAt: number | null;
  error?: string;
  disabled?: true;
};

/** The printer-state-reasons cups/backend/dell3115cn-supplies.py manages; printer-alert-description lists their texts. */
export const BACKEND_REASONS = [
  "door-open-error",
  "cover-open-error",
  "other-error",
  "input-tray-missing-warning",
  "media-empty-warning",
  "toner-low-warning",
  "marker-supply-low-warning",
];

const ATTRS = [
  "marker-names",
  "marker-colors",
  "marker-types",
  "marker-levels",
  "marker-low-levels",
  "marker-message",
  "printer-state-reasons",
  "printer-alert-description",
];
const FRESH_MS = 60_000; // CUPS updates after each job and every 6 hours; alerts should still show up quickly
const RETRY_MS = 60_000; // after a failure
const TIMEOUT_MS = 5000;
/** A refresh job wakes the printer (warm-up) and reads its state; give up waiting for it after this many seconds. */
const REFRESH_POLLS = 45;
const JOB_DONE = 7; // job-state canceled (7), aborted (8), completed (9)

export function suppliesFrom(a: IppAttributes): Supply[] {
  const list = (k: string) => a[k] ?? [];
  return list("marker-names").map((name, i) => {
    const raw = list("marker-levels")[i];
    const level = typeof raw === "number" && raw >= 0 && raw <= 100 ? raw : null; // -1 unavailable, -2 unknown, -3 some left
    const lowAt = list("marker-low-levels")[i];
    return {
      name: String(name),
      color: String(list("marker-colors")[i] ?? "none"),
      type: String(list("marker-types")[i] ?? "other"),
      level,
      low: level !== null && typeof lowAt === "number" && level <= lowAt,
    };
  });
}

/** Supplies, alerts and page count from the queue's attributes. */
export function printerFrom(a: IppAttributes): Omit<PrinterView, "checkedAt"> {
  const reasons = (a["printer-state-reasons"] ?? []).map(String).filter((r) => BACKEND_REASONS.includes(r));
  const message = String(a["printer-alert-description"]?.[0] ?? "");
  const alerts = reasons.length ? message.split("; ").map((s) => s.trim()).filter(Boolean) : [];
  const severity = reasons.some((r) => r.endsWith("-error")) ? "error" : reasons.length ? "warning" : null;
  const pages = /^(\d+) pages printed/.exec(String(a["marker-message"]?.[0] ?? ""));
  return { supplies: suppliesFrom(a), alerts, severity, pageCount: pages ? Number(pages[1]) : null };
}

/** ipp://host[:port]/path → http://host:port/path (631 by default); ipps → https. */
export function printerHttpUrl(uri: string): string {
  const m = /^(ipps?):\/\/([^/:]+)(?::(\d+))?(\/.*)?$/.exec(uri);
  if (!m) throw new Error(`Printer URI must start with ipp:// or ipps://: ${uri}`);
  return `${m[1] === "ipps" ? "https" : "http"}://${m[2]}:${m[3] ?? "631"}${m[4] ?? "/"}`;
}

/** What the API and MCP need: something that answers with the printer's state (a PrinterReader, or a test fake). */
export type PrinterSource = { get(): Promise<PrinterView>; refresh?(): Promise<PrinterView> };

export const PRINTER_OFF: PrinterView = { supplies: [], alerts: [], severity: null, pageCount: null, checkedAt: null, disabled: true };

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type PrinterReaderOptions = { fetch?: Fetch; clock?: () => number; wait?: (ms: number) => Promise<void> };

/** The printer's state from its CUPS queue, cached: CUPS is asked at most once a minute. */
export class PrinterReader {
  private cached: PrinterView | null = null;
  private pending: Promise<PrinterView> | null = null;
  private refreshing: Promise<PrinterView> | null = null;
  private readonly fetch: Fetch;
  private readonly clock: () => number;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(
    private readonly printerUri: string | null,
    opts: PrinterReaderOptions = {},
  ) {
    this.fetch = opts.fetch ?? fetch;
    this.clock = opts.clock ?? Date.now;
    this.wait = opts.wait ?? ((ms) => Bun.sleep(ms));
  }

  async get(): Promise<PrinterView> {
    if (!this.printerUri) return { ...PRINTER_OFF };
    const c = this.cached;
    if (c && this.clock() - c.checkedAt! < (c.error ? RETRY_MS : FRESH_MS)) return c;
    this.pending ??= this.read(this.printerUri).finally(() => (this.pending = null));
    return (this.cached = await this.pending);
  }

  /**
   * A fresh state on demand: sends the queue a "supply-refresh" job (the backend wakes the printer's engine with a
   * query that prints nothing, then reads its state), waits for it to finish and reads the queue again.
   */
  async refresh(): Promise<PrinterView> {
    if (!this.printerUri) return { ...PRINTER_OFF };
    this.refreshing ??= this.runRefresh(this.printerUri).finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async runRefresh(uri: string): Promise<PrinterView> {
    try {
      const job = jobAttributes(await this.ipp(uri, printJobRequest(uri, "supply-refresh", "scan-webapp", new Uint8Array([0x0a]), 2)));
      const jobId = job["job-id"]?.[0];
      if (typeof jobId !== "number") throw new Error("CUPS did not accept the refresh job");
      for (let i = 0; i < REFRESH_POLLS; i++) {
        const state = jobAttributes(await this.ipp(uri, getJobAttributesRequest(uri, jobId, 3)))["job-state"]?.[0];
        if (typeof state === "number" && state >= JOB_DONE) break;
        await this.wait(1000);
      }
    } catch (e) {
      return this.failed(`Printer check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.cached = null;
    return this.get();
  }

  private async read(uri: string): Promise<PrinterView> {
    const checkedAt = this.clock();
    try {
      return { ...printerFrom(printerAttributes(await this.ipp(uri, getPrinterAttributesRequest(uri, ATTRS, 1)))), checkedAt };
    } catch (e) {
      return this.failed(`Printer status unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private failed(error: string): PrinterView {
    const { disabled: _, ...off } = PRINTER_OFF;
    return { ...off, checkedAt: this.clock(), error };
  }

  /** One IPP request to CUPS; throws on HTTP or IPP errors. */
  private async ipp(uri: string, body: Uint8Array<ArrayBuffer>): Promise<IppMessage> {
    const res = await this.fetch(printerHttpUrl(uri), {
      method: "POST",
      headers: { "content-type": "application/ipp" },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`CUPS answered HTTP ${res.status}`);
    const msg = parseIpp(new Uint8Array(await res.arrayBuffer()));
    if (msg.status > 0xff) throw new Error(`CUPS answered IPP status 0x${msg.status.toString(16).padStart(4, "0")}`);
    return msg;
  }
}
