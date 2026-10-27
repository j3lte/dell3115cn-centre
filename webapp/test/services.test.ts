import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { openDb } from "../src/server/db";
import { LiveHub } from "../src/server/live";
import type { PrinterView } from "../src/server/printer";
import { ScannerClient } from "../src/server/scanner-client";
import { SecretBox } from "../src/server/secrets";
import { PrinterService } from "../src/server/services/printer-service";
import { createServices } from "../src/server/services";
import { tmpdir } from "./helpers";

const cal = { gains: [1, 1.1, 1.2] as [number, number, number], white: [200, 210, 220] as [number, number, number], at: 1 };

let db: ReturnType<typeof openDb>;
afterEach(() => db?.close());

function make(over: { printer?: Parameters<typeof createServices>[0]["printer"] } = {}) {
  const dataDir = tmpdir();
  db = openDb(join(dataDir, "db.sqlite"));
  const client = new ScannerClient("http://127.0.0.1:1");
  return createServices({
    db,
    box: new SecretBox("s"),
    secret: { secret: "s", generated: false },
    client,
    hub: new LiveHub(() => client.reconnectNow()),
    dataDir,
    ...over,
  });
}

const view = (pageCount: number): PrinterView => ({ supplies: [], alerts: [], severity: null, pageCount, readAt: null, checkedAt: 1 });

test("createServices wires one database through every service", () => {
  const s = make();
  const input = s.profiles.createInput({ name: "Feeder", source: "adf", mode: "gray", dpi: 150, paper: "a4", autoOrient: false, threshold: 128 });
  s.settings.update({ buttonInputProfileId: input.id }, { allowMcp: false });
  expect(s.settings.read().buttonInputProfileId).toBe(input.id);
  expect(s.scans.list(10)).toEqual([]);
});

test("PrinterService without a source answers the disabled view", async () => {
  const p = new PrinterService();
  const off = { supplies: [], alerts: [], severity: null, pageCount: null, readAt: null, checkedAt: null, disabled: true as const };
  expect(await p.get()).toEqual(off);
  expect(await p.refresh()).toEqual(off);
});

test("PrinterService.refresh falls back to get when the source cannot refresh", async () => {
  const p = new PrinterService({ get: async () => view(7) });
  expect(await p.refresh()).toEqual(view(7));
  const q = new PrinterService({ get: async () => view(7), refresh: async () => view(8) });
  expect(await q.get()).toEqual(view(7));
  expect(await q.refresh()).toEqual(view(8));
});

test("PrinterService.refreshIfStale passes the wake setting in milliseconds; null hours or no support only reads", async () => {
  const asked: number[] = [];
  let hours: number | null = 24;
  const source = { get: async () => view(7), refreshIfStale: async (ms: number) => (asked.push(ms), view(8)) };
  const p = new PrinterService(source, () => hours);
  expect(await p.refreshIfStale()).toEqual(view(8));
  expect(asked).toEqual([24 * 3_600_000]);
  hours = null;
  expect(await p.refreshIfStale()).toEqual(view(7));
  expect(asked).toHaveLength(1);
  expect(await new PrinterService({ get: async () => view(7) }, () => 1).refreshIfStale()).toEqual(view(7));
  expect((await new PrinterService().refreshIfStale()).disabled).toBe(true);
});

test("createServices: the printer service follows the printerWakeHours setting", async () => {
  const asked: number[] = [];
  const s = make({ printer: { get: async () => view(7), refreshIfStale: async (ms: number) => (asked.push(ms), view(8)) } });
  s.settings.update({ printerWakeHours: 6 }, { allowMcp: false });
  await s.printer.refreshIfStale();
  expect(asked).toEqual([6 * 3_600_000]);
});

test("CalibrationService.clear removes only that source", () => {
  const s = make();
  s.settings.setWhiteBalance("flatbed", cal);
  s.settings.setWhiteBalance("adf", cal);
  s.calibration.clear("adf");
  expect(s.settings.read().whiteBalance).toEqual({ flatbed: cal });
  expect(s.calibration.gains("flatbed")).toEqual(cal.gains);
  expect(s.calibration.gains("adf")).toBeUndefined();
});
