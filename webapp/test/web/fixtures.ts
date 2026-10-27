import { DEFAULT_FILTER } from "../../src/web/helpers/filter";
import type { InputProfile, OutputProfile, PrinterView, ScanView } from "../../src/web/types/api";

/** Test data and small helpers shared by the web UI tests. */

export const noop = () => {};

/** The path a request went to. */
export const path = (req: Request) => new URL(req.url).pathname;

/** "METHOD /path" of a request, to compare the API calls a component made. */
export const endpoint = (req: Request) => `${req.method} ${path(req)}`;

export const FEEDER: InputProfile = { id: 1, name: "Letters", source: "adf", mode: "gray", dpi: 300, paper: "a4", autoOrient: true, threshold: 128, filter: DEFAULT_FILTER };

export const OUTPUTS = [
  { id: 1, name: "To folder", destination: { type: "folder", config: {} } },
  { id: 2, name: "Paperless", destination: { type: "paperless", config: {} } },
] as unknown as OutputProfile[];

/** The printer's state (no supplies or alerts), with `over` applied. */
export const printerViewOf = (over: Partial<PrinterView> = {}): PrinterView => ({
  supplies: [],
  alerts: [],
  severity: null,
  pageCount: 66098,
  readAt: null,
  checkedAt: 1,
  ...over,
});

/** Page `n` of a scan, without its own filter. */
export const page = (n: number) => ({ n, width: 1240, height: 1754, rotation: 0, thumbUrl: `/t/${n}.png`, viewUrl: `/v/${n}.png`, filter: null });

/** A scan from the Scan page (scanning page 2, nothing delivered), with `over` applied. */
export const scanOf = (over: Partial<ScanView> = {}): ScanView => ({
  id: "s1",
  createdAt: 1_700_000_000_000,
  status: "scanning",
  review: false,
  inputProfile: FEEDER,
  outputProfileId: 1,
  outputProfileName: "To folder",
  origin: "ui",
  temporary: false,
  filter: DEFAULT_FILTER,
  pages: [page(1)],
  deliveries: [],
  ...over,
});
