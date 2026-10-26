import { describe, expect, test } from "bun:test";
import type { ScanView } from "../../src/server/services/scan-service";
import { activeScan, connectionInfo, displayedScan, INITIAL_LIVE, liveReducer, pendingReview } from "../../src/web/helpers/live";
import type { LiveState } from "../../src/web/types/ui";

const filter = { preset: "none", threshold: 160, brightness: 0, contrast: 0, autoCrop: false, deskew: false } as const;

function scan(id: string, over: Partial<ScanView> = {}): ScanView {
  return {
    id,
    createdAt: 1000,
    status: "scanning",
    review: false,
    inputProfile: { id: 1, name: "Feeder", source: "adf", mode: "gray", dpi: 300, paper: "a4", autoOrient: true, threshold: 128, filter },
    outputProfileId: 1,
    origin: "ui",
    temporary: false,
    filter,
    pages: [],
    deliveries: [],
    ...over,
  };
}

const page = (n: number) => ({ n, width: 100, height: 140, rotation: 0, thumbUrl: `/t/${n}`, viewUrl: `/v/${n}`, filter: null });
const ready = { service: "connected", printer: "idle", paperInFeeder: true } as const;

test("snapshot after a (re)connect replaces the state", () => {
  let s: LiveState = { ...INITIAL_LIVE, connected: true, scans: { old: scan("old", { status: "done" }) } };
  s = liveReducer(s, { type: "socket", connected: false });
  expect(s.connected).toBe(false);
  s = liveReducer(s, { type: "socket", connected: true });
  s = liveReducer(s, { type: "status", status: ready });
  s = liveReducer(s, { type: "scan", scan: scan("new", { createdAt: 2000 }) });
  expect(s.connected).toBe(true);
  expect(s.status).toEqual(ready);
  expect(Object.keys(s.scans)).toEqual(["new"]);
  expect(activeScan(s)?.id).toBe("new");
});

test("a scan message for the active scan updates its progress", () => {
  let s = liveReducer({ ...INITIAL_LIVE, connected: true }, { type: "scan", scan: scan("a") });
  s = liveReducer(s, { type: "scan", scan: scan("a", { pages: [page(1), page(2)] }) });
  expect(activeScan(s)?.pages).toHaveLength(2);
  s = liveReducer(s, { type: "scan", scan: scan("a", { status: "done", pages: [page(1), page(2), page(3)] }) });
  expect(activeScan(s)?.status).toBe("done");
});

test("the newest scan is the active one", () => {
  let s = liveReducer(INITIAL_LIVE, { type: "scan", scan: scan("b", { createdAt: 5000 }) });
  s = liveReducer(s, { type: "scan", scan: scan("a", { createdAt: 1000, status: "done" }) });
  expect(activeScan(s)?.id).toBe("b");
});

test("status unreachable keeps the last scan visible", () => {
  let s = liveReducer({ ...INITIAL_LIVE, connected: true }, { type: "scan", scan: scan("a", { status: "done" }) });
  s = liveReducer(s, { type: "status", status: { service: "unreachable", printer: null, paperInFeeder: false, error: "refused" } });
  expect(s.status.service).toBe("unreachable");
  expect(activeScan(s)?.id).toBe("a");
});

test("a deleted scan can be forgotten", () => {
  let s = liveReducer(INITIAL_LIVE, { type: "scan", scan: scan("a") });
  s = liveReducer(s, { type: "forget", id: "a" });
  expect(activeScan(s)).toBeUndefined();
});

test("connection bar: one clear state at a time, Scan only when ready", () => {
  const at = (connected: boolean, status: LiveState["status"]) => connectionInfo({ ...INITIAL_LIVE, connected, status });
  expect(at(false, ready)).toMatchObject({ text: "Connecting…", ready: false, canConnect: false });
  expect(at(true, { service: "connecting", printer: null, paperInFeeder: false })).toMatchObject({ text: "Connecting…", ready: false });
  expect(at(true, { service: "unreachable", printer: null, paperInFeeder: false })).toMatchObject({
    text: "Can't reach the scanner service — retrying",
    canConnect: true,
    ready: false,
  });
  expect(at(true, { service: "connected", printer: "off", paperInFeeder: false })).toMatchObject({
    text: "Printer is off — switch it on",
    canConnect: true,
    ready: false,
  });
  expect(at(true, { service: "connected", printer: "jammed", paperInFeeder: true })).toMatchObject({
    text: "Paper jam — open and close the ADF cover",
    ready: false,
  });
  expect(at(true, ready)).toMatchObject({ text: "Ready · paper in feeder", ready: true, tone: "ok" });
  expect(at(true, { ...ready, paperInFeeder: false })).toMatchObject({ text: "Ready", ready: true });
  expect(at(true, { ...ready, printer: "scanning" })).toMatchObject({ text: "Scanning…", ready: false });
});

test("a server notice is shown until dismissed", () => {
  let s = liveReducer(INITIAL_LIVE, { type: "notice", message: "Printer button pressed, but no default profiles are set" });
  expect(s.notice?.message).toBe("Printer button pressed, but no default profiles are set");
  s = liveReducer(s, { type: "dismissNotice" });
  expect(s.notice).toBeUndefined();
});

describe("which scan the Scan page shows", () => {
  const scans = (...list: ScanView[]) => Object.fromEntries(list.map((s) => [s.id, s]));
  const older = scan("older", { createdAt: 1000, status: "review", review: true, pages: [page(1)] });
  const newer = scan("newer", { createdAt: 2000, status: "review", review: true, pages: [page(1)] });
  const latest = scan("latest", { createdAt: 3000, status: "done" });

  test("without a choice: the newest scan", () => {
    expect(displayedScan(scans(older, newer, latest))?.id).toBe("latest");
    expect(displayedScan({})).toBeUndefined();
  });

  test("a chosen scan (Open in review / pending list) wins over the newest", () => {
    expect(displayedScan(scans(older, newer, latest), "older")?.id).toBe("older");
    // after Send it stays shown with its result
    expect(displayedScan(scans({ ...older, status: "done" }, newer, latest), "older")?.id).toBe("older");
  });

  test("a chosen scan that is unknown falls back to the newest", () => {
    expect(displayedScan(scans(older, latest), "gone")?.id).toBe("latest");
  });

  test("a newer scan in progress (e.g. the printer button) takes over from a chosen idle scan", () => {
    const running = scan("running", { createdAt: 4000, status: "scanning" });
    expect(displayedScan(scans(older, running), "older")?.id).toBe("running");
    expect(displayedScan(scans({ ...older, status: "delivering" }, running), "older")?.id).toBe("older");
  });

  test("pending review: every other scan in the tray, newest first", () => {
    const st = scans(older, newer, latest, scan("more", { createdAt: 2500, status: "scanning", review: true }));
    expect(pendingReview(st).map((s) => s.id)).toEqual(["more", "newer", "older"]);
    expect(pendingReview(st, "newer").map((s) => s.id)).toEqual(["more", "older"]);
    expect(pendingReview(scans(latest))).toEqual([]);
  });
});

test("assistant scans never show in the review tray, even while scanning more pages", async () => {
  const { inTray } = await import("../../src/web/helpers/live");
  expect(inTray(scan("m", { status: "scanning", review: true, origin: "mcp" }))).toBe(false);
  expect(inTray(scan("u", { status: "scanning", review: true, origin: "ui" }))).toBe(true);
});
