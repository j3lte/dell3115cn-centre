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

function make(over: Partial<Pick<Parameters<typeof createServices>[0], "printer" | "clock">> = {}) {
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

const HOUR = 3_600_000;

/** A printer source whose last read is `readAt`; a refresh reads the printer now (or, `off`, changes nothing). */
function fakeSource(clock: () => number, readAt: number | null, opts: { off?: boolean; error?: string } = {}) {
  const state = { readAt, refreshes: 0 };
  const now = (): PrinterView => ({ ...view(7), readAt: state.readAt, ...(opts.error ? { error: opts.error } : {}) });
  return {
    state,
    source: {
      get: async () => now(),
      refresh: async () => {
        state.refreshes++;
        if (!opts.off) state.readAt = clock();
        return now();
      },
    },
  };
}

test("PrinterService.refreshIfStale wakes the printer only when the last read is older than the wake setting", async () => {
  let t = 100 * HOUR;
  const { state, source } = fakeSource(() => t, t - 2 * HOUR);
  const p = new PrinterService(source, () => 3, () => t);
  expect((await p.refreshIfStale()).readAt).toBe(t - 2 * HOUR);
  expect(state.refreshes).toBe(0);
  t += 2 * HOUR;
  expect((await p.refreshIfStale()).readAt).toBe(t);
  expect(state.refreshes).toBe(1);
});

test("PrinterService.refreshIfStale wakes when the printer was never read; not when the setting is off or CUPS fails", async () => {
  const never = fakeSource(Date.now, null);
  await new PrinterService(never.source, () => 24).refreshIfStale();
  expect(never.state.refreshes).toBe(1);
  const off = fakeSource(Date.now, null);
  await new PrinterService(off.source, () => null).refreshIfStale();
  expect(off.state.refreshes).toBe(0);
  const down = fakeSource(Date.now, null, { error: "Printer status unavailable: ECONNREFUSED" });
  expect((await new PrinterService(down.source, () => 24).refreshIfStale()).error).toContain("ECONNREFUSED");
  expect(down.state.refreshes).toBe(0);
  expect((await new PrinterService(undefined, () => 24).refreshIfStale()).disabled).toBe(true);
  expect(await new PrinterService({ get: async () => view(7) }, () => 24).refreshIfStale()).toEqual(view(7));
});

test("PrinterService.refreshIfStale counts a wake attempt as a read (printer switched off), Check now too", async () => {
  let t = 100 * HOUR;
  const { state, source } = fakeSource(() => t, t - 30 * HOUR, { off: true });
  const p = new PrinterService(source, () => 24, () => t);
  await p.refreshIfStale();
  expect(state.refreshes).toBe(1);
  t += 23 * HOUR;
  await p.refreshIfStale();
  expect(state.refreshes).toBe(1);
  await p.refresh(); // Check now
  t += 2 * HOUR;
  await p.refreshIfStale();
  expect(state.refreshes).toBe(2);
  t += 23 * HOUR;
  await p.refreshIfStale();
  expect(state.refreshes).toBe(3);
});

test("createServices: the printer service follows the printerWakeHours setting", async () => {
  const t = 100 * HOUR;
  const { state, source } = fakeSource(() => t, t - 7 * HOUR);
  const s = make({ printer: source, clock: () => t });
  await s.printer.refreshIfStale();
  expect(state.refreshes).toBe(0);
  s.settings.update({ printerWakeHours: 6 }, { allowMcp: false });
  await s.printer.refreshIfStale();
  expect(state.refreshes).toBe(1);
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
