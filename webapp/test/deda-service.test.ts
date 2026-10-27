import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { AnalyseClient, type DedaReport } from "../src/server/analyse-client";
import { ValidationError } from "../src/server/destinations/types";
import { configureLog } from "../src/server/log";
import type { InputProfileDraft } from "../src/server/profiles";
import { DedaRepo } from "../src/server/repos/deda-repo";
import { ScanRepo } from "../src/server/repos/scan-repo";
import { NotFound } from "../src/server/services/errors";
import type { DedaService } from "../src/server/services/deda-service";
import { captureLog, scanInsert, withoutDeviceIcc } from "./helpers";
import { makeHarness, type Harness } from "./scan-harness";

let h: Harness;
afterEach(() => h?.close());

const png = (s: string) => Buffer.from(s).toString("base64");
const REPORT: DedaReport = {
  found: true,
  dots: 321,
  gridScore: 0.87,
  dpi: 600,
  paperWhite: [250, 251, 249],
  decode: { serial: "123456", pattern: "4" },
  decodeError: null,
  images: { overview: png("overview-png"), closeRaw: png("raw-png"), closeYellow: png("yellow-png") },
};

/** An AnalyseClient over a fake fetch that records every call and how many ran at once. */
function analyser(o: { holdFirst?: Promise<void>; delayMs?: number; unreachable?: boolean } = {}) {
  const calls: { dpi: number; body: Uint8Array }[] = [];
  const stats = { active: 0, maxActive: 0 };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (o.unreachable) throw new TypeError("fetch failed");
    stats.active++;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    try {
      calls.push({ dpi: Number(new URL(String(input)).searchParams.get("dpi")), body: new Uint8Array(init!.body as Uint8Array) });
      if (calls.length === 1 && o.holdFirst) await o.holdFirst;
      if (o.delayMs) await Bun.sleep(o.delayMs);
      return Response.json(REPORT);
    } finally {
      stats.active--;
    }
  }) as unknown as typeof fetch;
  return { client: new AnalyseClient("http://analyse.test", { fetchImpl }), calls, stats };
}

async function setup(a = analyser(), clock?: () => number): Promise<DedaService> {
  h = await makeHarness({ analyse: a.client, clock });
  h.fake.scenario = { pages: 1 };
  return h.services.deda!;
}

/** A stored History scan with one page. */
async function storedScan(over: Partial<InputProfileDraft> = {}): Promise<string> {
  const v = await h.svc.start(h.input({ source: "flatbed", paper: "glass", mode: "color", dpi: 600, ...over }).id, h.folderOutput().id, { review: true });
  await h.svc.settled(v.id);
  return v.id;
}

const pageFile = (scanId: string) => join(h.dataDir, "scans", scanId, "page-001.png");

describe("DEDA service", () => {
  withoutDeviceIcc();

  test("no analyse client, no DEDA service", async () => {
    h = await makeHarness();
    expect(h.services.deda).toBeNull();
  });

  test("history page analysed and stored", async () => {
    const at = new Date(2026, 0, 2, 3, 4, 5).getTime();
    const a = analyser();
    const deda = await setup(a, () => at);
    const scanId = await storedScan();
    const started = deda.fromHistory(scanId, 1);
    expect(started).toMatchObject({ status: "analysing", source: "history", scanId, page: 1, dpi: 600, scannedAt: at });
    expect(started.name).toMatch(/^Deda scan \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(started.name).toBe("Deda scan 2026-01-02 03:04:05");
    await deda.idle();

    const v = deda.get(started.id)!;
    expect(v).toMatchObject({
      status: "done",
      analysedAt: at,
      found: true,
      dots: 321,
      gridScore: 0.87,
      decode: { serial: "123456", pattern: "4" },
      decodeError: null,
      error: null,
    });
    expect(v.images.sort()).toEqual(["closeRaw", "closeYellow", "overview"]);
    expect(readFileSync(deda.imagePath(v.id, "overview")!, "utf8")).toBe("overview-png");
    expect(deda.imagePath(v.id, "closeYellow")).toBe(join(h.dataDir, "deda", v.id, "closeYellow.png"));
    expect(deda.imagePath(v.id, "closeEnhanced")).toBeNull();
    expect(deda.imagePath(v.id, "../../db.sqlite")).toBeNull();
    // the stored lossless PNG went over as-is, at the page's dpi
    expect(a.calls).toHaveLength(1);
    expect(a.calls[0]!.dpi).toBe(600);
    expect(Buffer.from(a.calls[0]!.body).equals(readFileSync(pageFile(scanId)))).toBe(true);
    // the source scan stays
    expect(h.svc.get(scanId)).not.toBeNull();
    expect(deda.list().map((x) => x.id)).toEqual([v.id]);
  });

  test("a 16-bit colour page is sent as its stored 16-bit PNG", async () => {
    const a = analyser();
    const deda = await setup(a);
    const scanId = await storedScan({ depth: 16 });
    expect((await sharp(pageFile(scanId)).metadata()).depth).toBe("ushort");
    deda.fromHistory(scanId, 1);
    await deda.idle();
    expect(deda.list()[0]!.status).toBe("done");
    expect(Buffer.from(a.calls[0]!.body).equals(readFileSync(pageFile(scanId)))).toBe(true);
  });

  test("tab scan is temporary, never listed in History, removed after", async () => {
    const at = new Date(2026, 9, 27, 14, 5, 9).getTime();
    let historyDuring: string[] = [];
    const a = analyser();
    const deda = await setup(a, () => at);
    const started = deda.fromScan();
    expect(started).toMatchObject({ status: "scanning", source: "scan", scannedAt: at, name: "Deda scan 2026-10-27 14:05:09" });
    // peek at History while the analysis runs
    const orig = a.client.deda.bind(a.client);
    a.client.deda = async (page, dpi, signal) => {
      historyDuring = h.svc.list().map((s) => s.id);
      expect(deda.get(started.id)!.status).toBe("analysing");
      return orig(page, dpi, signal);
    };
    await deda.idle();

    const v = deda.get(started.id)!;
    expect(v).toMatchObject({ status: "done", source: "scan", page: 1, dpi: 600, found: true });
    const tempId = v.scanId!;
    expect(tempId).toBeTruthy();
    expect(historyDuring).toEqual([]);
    expect(h.svc.list()).toEqual([]);
    expect(h.messages.some((m) => m.type === "scan" && m.scan.id === tempId)).toBe(false);
    expect(h.svc.get(tempId, { includeTemporary: true })).toBeNull();
    expect(existsSync(join(h.dataDir, "scans", tempId))).toBe(false);
    // flatbed, colour, 600 dpi, 8-bit, an A4 region of the glass
    expect(h.fake.requests.at(-1)).toEqual({ source: "flatbed", mode: "color", dpi: 600, area_mm: [0, 0, 210, 296.8] });
    expect(a.calls[0]!.dpi).toBe(600);
  });

  test("a tab scan is dated by the scan's creation, not the button press", async () => {
    let now = new Date(2026, 9, 27, 14, 5, 9).getTime();
    const deda = await setup(analyser(), () => now);
    const started = deda.fromScan();
    now = new Date(2026, 9, 27, 14, 5, 14).getTime(); // the scan is made a few seconds later
    await deda.idle();
    expect(deda.get(started.id)).toMatchObject({ status: "done", scannedAt: now, name: "Deda scan 2026-10-27 14:05:14" });
  });

  test("a renamed tab scan keeps its name when the scan time is set", async () => {
    let now = new Date(2026, 9, 27, 14, 5, 9).getTime();
    const deda = await setup(analyser(), () => now);
    const started = deda.fromScan();
    deda.rename(started.id, "My page");
    now += 5000;
    await deda.idle();
    expect(deda.get(started.id)).toMatchObject({ name: "My page", scannedAt: now });
  });

  test("a failed tab scan fails the entry with the scan's error", async () => {
    const a = analyser();
    const deda = await setup(a);
    h.fake.scenario = { pages: 0, end: "error", message: "lamp failure" };
    const started = deda.fromScan();
    await deda.idle();
    const v = deda.get(started.id)!;
    expect(v.status).toBe("failed");
    expect(v.error).toContain("lamp failure");
    expect(a.calls).toHaveLength(0);
    expect(h.svc.get(v.scanId!, { includeTemporary: true })).toBeNull();
  });

  test("refuses gray and low-dpi pages", async () => {
    const a = analyser();
    const deda = await setup(a);
    const gray = await storedScan({ mode: "gray" });
    const low = await storedScan({ dpi: 200 });
    expect(() => deda.fromHistory(gray, 1)).toThrow(ValidationError);
    expect(() => deda.fromHistory(low, 1)).toThrow(ValidationError);
    expect(() => deda.fromHistory(low, 2)).toThrow(NotFound);
    expect(() => deda.fromHistory("nope", 1)).toThrow(NotFound);
    await deda.idle();
    expect(deda.list()).toEqual([]);
    expect(a.calls).toHaveLength(0);
    // 300 dpi is the lowest accepted
    const ok = await storedScan({ dpi: 300 });
    expect(deda.fromHistory(ok, 1).dpi).toBe(300);
    await deda.idle();
  });

  test("service unreachable fails the entry", async () => {
    const deda = await setup(analyser({ unreachable: true }));
    const scanId = await storedScan();
    const started = deda.fromHistory(scanId, 1);
    await deda.idle();
    expect(deda.get(started.id)).toMatchObject({ status: "failed", error: "Analyse service unreachable", found: null, images: [] });
    // the queue keeps working: a tab scan still runs and removes its temporary scan
    const next = deda.fromScan();
    await deda.idle();
    expect(deda.get(next.id)).toMatchObject({ status: "failed", error: "Analyse service unreachable" });
    expect(h.svc.get(deda.get(next.id)!.scanId!, { includeTemporary: true })).toBeNull();
  });

  test("missing source page fails the entry", async () => {
    let release!: () => void;
    const a = analyser({ holdFirst: new Promise<void>((r) => (release = r)) });
    const deda = await setup(a);
    const first = await storedScan();
    const second = await storedScan();
    const e1 = deda.fromHistory(first, 1);
    const e2 = deda.fromHistory(second, 1);
    while (a.calls.length === 0) await Bun.sleep(2);
    await h.svc.remove(second); // deleted while queued
    release();
    await deda.idle();
    expect(deda.get(e1.id)!.status).toBe("done");
    expect(deda.get(e2.id)).toMatchObject({ status: "failed", error: "Scan page no longer exists" });
    expect(a.calls).toHaveLength(1);
  });

  test("analyses run one at a time", async () => {
    let now = 1_800_000_000_000;
    const a = analyser({ delayMs: 30 });
    const deda = await setup(a, () => now);
    const s1 = await storedScan();
    now += 1000;
    const s2 = await storedScan();
    now += 1000;
    const e1 = deda.fromHistory(s1, 1);
    const e2 = deda.fromHistory(s2, 1);
    const e3 = deda.fromScan();
    await deda.idle();
    expect(a.calls).toHaveLength(3);
    expect(a.stats.maxActive).toBe(1);
    expect([e1, e2, e3].map((e) => deda.get(e.id)!.status)).toEqual(["done", "done", "done"]);
    // newest scannedAt first
    expect(deda.list().map((e) => e.id)).toEqual([e3.id, e2.id, e1.id]);
  });

  test("restart fails pending entries", async () => {
    const deda = await setup();
    const repo = new DedaRepo(h.db);
    const scans = new ScanRepo(h.db);
    const tempId = "0190a000-0000-7000-8000-000000000001";
    scans.insertScan(scanInsert(tempId, { origin: "analyse", expires_at: Date.now() + 60_000 }));
    mkdirSync(join(h.dataDir, "scans", tempId), { recursive: true });
    const row = (id: string, status: "scanning" | "analysing" | "done", source: "scan" | "history", scan_id: string | null) =>
      repo.insert({ id, name: `Entry ${id}`, status, source, scan_id, page: null, dpi: null, scanned_at: 1 });
    row("a", "scanning", "scan", tempId);
    row("b", "analysing", "history", "some-history-scan");
    row("c", "done", "history", "some-history-scan");
    row("d", "scanning", "scan", null);

    expect(deda.recover()).toBe(3);
    await deda.idle();
    for (const id of ["a", "b", "d"]) expect(deda.get(id)).toMatchObject({ status: "failed", error: "Interrupted by a restart" });
    expect(deda.get("c")!.status).toBe("done");
    expect(h.svc.get(tempId, { includeTemporary: true })).toBeNull();
    expect(existsSync(join(h.dataDir, "scans", tempId))).toBe(false);
    expect(deda.recover()).toBe(0);
  });

  test("a job whose bookkeeping throws does not stop the queue", async () => {
    const deda = await setup();
    const scanId = await storedScan();
    const first = deda.fromHistory(scanId, 1);
    const second = deda.fromHistory(scanId, 1);
    // every read of the first entry throws: the job itself and the failure handler
    const realGet = DedaRepo.prototype.get;
    const spy = spyOn(DedaRepo.prototype, "get").mockImplementation(function (this: DedaRepo, id: string) {
      if (id === first.id) throw new Error("db gone");
      return realGet.call(this, id);
    });
    const errors: string[] = [];
    const restore = configureLog({ sink: (l) => void (l.includes(" ERROR ") && errors.push(l)) });
    try {
      await deda.idle();
    } finally {
      spy.mockRestore();
      restore();
    }
    expect(deda.get(second.id)!.status).toBe("done");
    expect(errors.length).toBeGreaterThan(0);
  });

  test("rename trims and validates", async () => {
    const deda = await setup();
    const e = deda.fromHistory(await storedScan(), 1);
    await deda.idle();
    expect(deda.rename(e.id, "  Office printer  ").name).toBe("Office printer");
    expect(deda.get(e.id)!.name).toBe("Office printer");
    expect(() => deda.rename(e.id, "   ")).toThrow(ValidationError);
    expect(() => deda.rename(e.id, "x".repeat(101))).toThrow(ValidationError);
    expect(deda.rename(e.id, "x".repeat(100)).name).toHaveLength(100);
    expect(() => deda.rename("nope", "Name")).toThrow(NotFound);
  });

  test("remove deletes files", async () => {
    const deda = await setup();
    const scanId = await storedScan();
    const e = deda.fromHistory(scanId, 1);
    const keep = deda.fromHistory(scanId, 1);
    await deda.idle();
    expect(existsSync(join(h.dataDir, "deda", e.id))).toBe(true);
    deda.remove(e.id);
    expect(deda.get(e.id)).toBeNull();
    expect(existsSync(join(h.dataDir, "deda", e.id))).toBe(false);
    expect(deda.get(keep.id)!.status).toBe("done");
    expect(existsSync(join(h.dataDir, "deda", keep.id))).toBe(true);
    expect(() => deda.remove(e.id)).toThrow(NotFound);
  });

  test("clear empties table and folder", async () => {
    const deda = await setup();
    const scanId = await storedScan();
    deda.fromHistory(scanId, 1);
    deda.fromHistory(scanId, 1);
    await deda.idle();
    expect(readdirSync(join(h.dataDir, "deda"))).toHaveLength(2);
    expect(deda.clear()).toBe(2);
    expect(deda.list()).toEqual([]);
    expect(existsSync(join(h.dataDir, "deda"))).toBe(false);
    expect(deda.clear()).toBe(0);
  });
});

describe("DEDA candidates", () => {
  withoutDeviceIcc();

  test("stored scans with a colour page of 300 dpi or more, newest first, only those pages", async () => {
    let now = 1000;
    const deda = await setup(analyser(), () => now++);
    const low = await storedScan({ dpi: 200 });
    const gray = await storedScan({ mode: "gray" });
    const d300 = await storedScan({ dpi: 300 });
    const d600 = await storedScan({ dpi: 600 });
    // a temporary scan with a good page is not offered
    const repo = new ScanRepo(h.db);
    repo.insertScan(scanInsert("temp", { created_at: 9e12, expires_at: 9e12 + 1 }));
    repo.insertPage({ scan_id: "temp", n: 1, path: "x", width: 1, height: 1, dpi: 600, mode: "color", rotation: 0 });
    // a scan with a colour 600 dpi page and a gray page lists only the colour one
    repo.insertScan(scanInsert("mixed", { created_at: 5 }));
    repo.insertPage({ scan_id: "mixed", n: 1, path: "x", width: 1, height: 1, dpi: 600, mode: "gray", rotation: 0 });
    repo.insertPage({ scan_id: "mixed", n: 2, path: "x", width: 1, height: 1, dpi: 600, mode: "color", rotation: 0 });

    const c = deda.candidates();
    expect(c.map((s) => s.id)).toEqual([d600, d300, "mixed"]);
    expect(c.map((s) => s.id).filter((id) => id !== "mixed")).toEqual([d600, d300]);
    expect(c.map((s) => s.id)).not.toContain(low);
    expect(c.map((s) => s.id)).not.toContain(gray);
    expect(c.map((s) => s.id)).not.toContain("temp");
    expect(c.find((s) => s.id === d600)!.pages).toEqual([{ n: 1, dpi: 600, mode: "color", lowDpi: false }]);
    expect(c.find((s) => s.id === d300)!.pages).toEqual([{ n: 1, dpi: 300, mode: "color", lowDpi: true }]);
    expect(c.find((s) => s.id === "mixed")!.pages).toEqual([{ n: 2, dpi: 600, mode: "color", lowDpi: false }]);
  });

  test("limit caps the scans", async () => {
    const deda = await setup();
    const repo = new ScanRepo(h.db);
    for (let i = 0; i < 4; i++) {
      repo.insertScan(scanInsert(`s${i}`, { created_at: 100 + i }));
      repo.insertPage({ scan_id: `s${i}`, n: 1, path: "x", width: 1, height: 1, dpi: 600, mode: "color", rotation: 0 });
    }
    expect(deda.candidates(2).map((s) => s.id)).toEqual(["s3", "s2"]);
    expect(deda.candidates()).toHaveLength(4);
  });
});

describe("DEDA service log", () => {
  withoutDeviceIcc();
  const lines = captureLog();
  const deda = () => lines.filter((l) => l.slice(6).startsWith("deda:"));

  test("started and done with the dot count, never the decode", async () => {
    const svc = await setup();
    const scanId = await storedScan();
    const e = svc.fromHistory(scanId, 1);
    await svc.idle();
    expect(deda()).toEqual([`INFO  deda: ${e.id} started from history (scan ${scanId} page 1)`, `INFO  deda: ${e.id} done: dots found (321), decoded`]);
    expect(lines.join("\n")).not.toContain("123456");
  });

  test("a failure is a warning", async () => {
    const svc = await setup(analyser({ unreachable: true }));
    const e = svc.fromScan();
    await svc.idle();
    expect(deda()[0]).toBe(`INFO  deda: ${e.id} started from a glass scan`);
    expect(deda().at(-1)).toStartWith(`WARN  deda: ${e.id} failed: `);
  });
});
