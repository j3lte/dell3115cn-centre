import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { sftp } from "../src/server/destinations/sftp";
import { DEFAULT_FILTER } from "../src/server/pipeline/filters";
import { deviceIccPath } from "../src/server/pipeline/icc";
import { magickAvailable } from "../src/server/pipeline/magick";
import { ScanRepo } from "../src/server/repos/scan-repo";
import { ScannerBusy, PrinterOff } from "../src/server/scanner-client";
import { StateError } from "../src/server/services/errors";
import { adhocProfile, type ScanView } from "../src/server/services/scan-service";
import { makeColourPnm, makePnm } from "./fake-service";
import { withoutDeviceIcc } from "./helpers";
import { makeHarness, pdfImageBits, pdfPages, pdfWidths, type Harness } from "./scan-harness";

let h: Harness;
afterEach(() => h?.close());

const only = (v: ScanView) => v.deliveries.map((d) => ({ status: d.status, error: d.error }));

test("default flow: 3 pages -> done, one delivery sent, one 3-page PDF in the folder", async () => {
  h = await makeHarness();
  h.fake.scenario = { pages: 3 };
  const inp = h.input();
  const out = h.folderOutput();
  const started = await h.svc.start(inp.id, out.id, { review: false });
  expect(started.status).toBe("scanning");
  await h.svc.settled(started.id);
  const v = h.svc.get(started.id)!;
  expect(v.status).toBe("done");
  expect(v.pages.map((p) => p.n)).toEqual([1, 2, 3]);
  expect(only(v)).toEqual([{ status: "sent", error: undefined }]);
  expect(h.outFiles()).toHaveLength(1);
  expect(await pdfPages(join(h.outDir, h.outFiles()[0]!))).toBe(3);
  // service request mapping: adf -> paper as-is, no threshold for gray
  expect(h.fake.requests.at(-1)).toEqual({ source: "adf", mode: "gray", dpi: 150, paper: "a4" });
  // the finished job is deleted on the service
  expect(h.fake.deleted).toHaveLength(1);
  // live updates went out: scanning ... done
  const statuses = h.messages.filter((m) => m.type === "scan").map((m) => (m as any).scan.status);
  expect(statuses[0]).toBe("scanning");
  expect(statuses.at(-1)).toBe("done");
  expect(statuses).toContain("delivering");
  // pages and thumbs on disk
  expect(existsSync(join(h.dataDir, "scans", v.id))).toBe(true);
});

test("lineart sends threshold; flatbed glass sends no paper", async () => {
  h = await makeHarness();
  const bw = h.input({ mode: "lineart", threshold: 140 });
  await h.svc.settled((await h.svc.start(bw.id, h.folderOutput().id, { review: false })).id);
  expect(h.fake.requests.at(-1)).toEqual({ source: "adf", mode: "lineart", dpi: 150, paper: "a4", threshold: 140 });
  const fb = h.input({ source: "flatbed", paper: "glass" });
  const png = h.folderOutput({ format: "png" });
  await h.svc.settled((await h.svc.start(fb.id, png.id, { review: false })).id);
  expect(h.fake.requests.at(-1)).toEqual({ source: "flatbed", mode: "gray", dpi: 150 });
});

test("review flow: rotate, remove, reorder, more, then send", async () => {
  h = await makeHarness();
  let w = 100;
  // pages of distinct widths so the PDF order can be checked
  h.fake.scenario = { pages: 3, page: () => makePnm("gray", (w += 10), 150) };
  const v0 = await h.svc.start(h.input().id, h.folderOutput().id, { review: true });
  await h.svc.settled(v0.id);
  let v = h.svc.get(v0.id)!;
  expect(v.status).toBe("review");
  expect(v.deliveries).toEqual([]);
  expect(v.pages.map((p) => p.width)).toEqual([110, 120, 130]);

  v = await h.svc.rotate(v.id, 2, 90); // page 2: 120x150 -> 150x120
  expect(v.pages[1]).toMatchObject({ n: 2, width: 150, height: 120, rotation: 90 });
  v = await h.svc.removePage(v.id, 3);
  expect(v.pages.map((p) => p.width)).toEqual([110, 150]);
  v = await h.svc.reorder(v.id, [2, 1]);
  expect(v.pages.map((p) => [p.n, p.width])).toEqual([
    [1, 150],
    [2, 110],
  ]);
  h.fake.scenario = { pages: 2, page: () => makePnm("gray", (w += 10), 150) };
  await h.svc.more(v.id);
  await h.svc.settled(v.id);
  v = h.svc.get(v.id)!;
  expect(v.status).toBe("review");
  expect(v.pages.map((p) => p.width)).toEqual([150, 110, 140, 150]);
  await h.svc.send(v.id);
  v = h.svc.get(v.id)!;
  expect(v.status).toBe("done");
  const pdf = join(h.outDir, h.outFiles()[0]!);
  expect(await pdfPages(pdf)).toBe(4);
  // 150 dpi: points = px * 72 / 150
  expect(await pdfWidths(pdf)).toEqual([150, 110, 140, 150].map((px) => Math.round((px * 72) / 150)));
});

test("jam after 3 pages -> done with problem, 3 pages delivered", async () => {
  h = await makeHarness();
  h.fake.scenario = { pages: 3, end: "jam" };
  const v0 = await h.svc.start(h.input().id, h.folderOutput().id, { review: false });
  await h.svc.settled(v0.id);
  const v = h.svc.get(v0.id)!;
  expect(v.status).toBe("done");
  expect(v.problem).toContain("after page 3");
  expect(v.problem).toContain("ADF cover");
  expect(await pdfPages(join(h.outDir, h.outFiles()[0]!))).toBe(3);
});

test("feeder_empty with 0 pages -> failed 'No paper in the feeder'", async () => {
  h = await makeHarness();
  h.fake.scenario = { pages: 0 };
  const v0 = await h.svc.start(h.input().id, h.folderOutput().id, { review: false });
  await h.svc.settled(v0.id);
  const v = h.svc.get(v0.id)!;
  expect(v.status).toBe("failed");
  expect(v.error).toBe("No paper in the feeder");
  expect(v.deliveries).toEqual([]);
  expect(h.outFiles()).toEqual([]);
});

test("test_service_lost_mid_scan", async () => {
  h = await makeHarness();
  h.fake.scenario = { pages: 4, dieAfterPages: 2 };
  const v0 = await h.svc.start(h.input().id, h.folderOutput().id, { review: false });
  await h.svc.settled(v0.id);
  const v = h.svc.get(v0.id)!;
  expect(v.problem).toBe("Connection to scanner lost after page 2");
  expect(v.pages).toHaveLength(2);
  expect(v.status).toBe("done");
  expect(await pdfPages(join(h.outDir, h.outFiles()[0]!))).toBe(2);
  expect(h.client.status.service).toBe("unreachable");
});

test("a page download that stalls ends the scan within the watchdog time with 'connection lost'", async () => {
  h = await makeHarness({ client: { pageIdleTimeoutMs: 300 } });
  h.fake.scenario = { pages: 3, stallPage: 2 };
  const t0 = Date.now();
  const v0 = await h.svc.start(h.input().id, h.folderOutput().id, { review: false });
  await h.svc.settled(v0.id);
  expect(Date.now() - t0).toBeLessThan(3000);
  const v = h.svc.get(v0.id)!;
  expect(v.problem).toBe("Connection to scanner lost after page 1");
  expect(v.pages).toHaveLength(1);
  expect(v.status).toBe("done");
}, 10000);

test("a lost batch still deletes its job on the service", async () => {
  h = await makeHarness({ client: { pageIdleTimeoutMs: 300 } });
  h.fake.scenario = { pages: 2, stallPage: 2 };
  const v0 = await h.svc.start(h.input().id, h.folderOutput().id, { review: false });
  await h.svc.settled(v0.id);
  expect(h.svc.get(v0.id)!.problem).toBe("Connection to scanner lost after page 1");
  expect(h.fake.deleted).toHaveLength(1);
}, 10000);

test("downloaded pages wait on disk, not in memory, and are removed once processed", async () => {
  h = await makeHarness();
  const v0 = await h.svc.start(h.input().id, h.folderOutput().id, { review: false });
  await h.svc.settled(v0.id);
  expect(h.svc.get(v0.id)!.pages).toHaveLength(2);
  expect(readdirSync(join(h.dataDir, "scans", v0.id)).filter((f) => f.endsWith(".pnm"))).toEqual([]);
});

test("cancel of a job the service no longer knows (404) ends the scan as cancelled", async () => {
  h = await makeHarness();
  h.fake.scenario = { pages: 1, pageDelayMs: 5000 };
  const v0 = await h.svc.start(h.input().id, h.folderOutput().id, { review: false });
  await Bun.sleep(50);
  h.fake.jobs.clear(); // e.g. the service restarted
  const t0 = Date.now();
  await h.svc.cancel(v0.id);
  await h.svc.settled(v0.id);
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(h.svc.get(v0.id)!.status).toBe("cancelled");
}, 10000);

test("two Sends at once deliver once; the second gets a conflict", async () => {
  h = await makeHarness();
  const v0 = await h.svc.start(h.input().id, h.folderOutput({ format: "png" }).id, { review: true });
  await h.svc.settled(v0.id);
  expect(h.svc.get(v0.id)!.status).toBe("review");
  const results = await Promise.allSettled([h.svc.send(v0.id), h.svc.send(v0.id)]);
  expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  expect(rejected.reason).toBeInstanceOf(StateError);
  await h.svc.settled(v0.id);
  expect(only(h.svc.get(v0.id)!)).toEqual([{ status: "sent", error: undefined }]);
  expect(h.outFiles()).toHaveLength(2); // 2 pages, png → 2 files, once
});

test("a cancelled scan with pages can be sent from history", async () => {
  h = await makeHarness();
  const out = h.folderOutput({ format: "png" }).id;
  const v0 = await h.svc.start(h.input().id, out, { review: true });
  await h.svc.settled(v0.id);
  await h.svc.cancel(v0.id); // Discard in the review tray
  expect(h.svc.get(v0.id)!.status).toBe("cancelled");
  const v = await h.svc.resend(v0.id, out);
  expect(v.status).toBe("done");
  expect(only(v)).toEqual([{ status: "sent", error: undefined }]);
  expect(h.outFiles()).toHaveLength(2);
});

test("a cancelled scan without pages can't be sent", async () => {
  h = await makeHarness();
  h.fake.scenario = { pages: 1, pageDelayMs: 1000 };
  const out = h.folderOutput().id;
  const v0 = await h.svc.start(h.input().id, out, { review: false });
  await Bun.sleep(50);
  await h.svc.cancel(v0.id);
  await h.svc.settled(v0.id);
  expect(h.svc.get(v0.id)!.status).toBe("cancelled");
  await expect(h.svc.resend(v0.id, out)).rejects.toThrow("This scan has no pages");
});

test("two resends at once deliver once", async () => {
  h = await makeHarness();
  const out = h.folderOutput({ format: "pdf_multi" }).id;
  const v0 = await h.svc.start(h.input().id, out, { review: false });
  await h.svc.settled(v0.id);
  const results = await Promise.allSettled([h.svc.resend(v0.id, out), h.svc.resend(v0.id, out)]);
  expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  await h.svc.settled(v0.id);
  expect(h.svc.get(v0.id)!.deliveries).toHaveLength(2);
});

test("test_failed_delivery_then_resend", async () => {
  h = await makeHarness();
  const paperless = Bun.serve({ port: 0, fetch: () => new Response("boom", { status: 500, statusText: "Internal Server Error" }) });
  try {
    const bad = h.repo.saveOutput({
      name: "Paperless",
      format: "pdf_multi",
      jpegQuality: 80,
      filenameTemplate: "scan",
      destination: { type: "paperless", config: { url: `http://127.0.0.1:${paperless.port}`, token: "t" } },
    });
    const v0 = await h.svc.start(h.input().id, bad.id, { review: false });
    await h.svc.settled(v0.id);
    let v = h.svc.get(v0.id)!;
    expect(v.status).toBe("failed");
    expect(v.deliveries).toHaveLength(1);
    expect(v.deliveries[0]!.status).toBe("failed");
    expect(v.deliveries[0]!.error).toContain("500");
    expect(v.deliveries[0]!.files.length).toBe(1); // the encoded file is kept and downloadable
    const folder = h.folderOutput();
    v = await h.svc.resend(v.id, folder.id);
    expect(v.status).toBe("done");
    // the UI needs the profile of each delivery (e.g. to tell a Download delivery apart)
    expect(v.deliveries.map((d) => d.outputProfileId)).toEqual([bad.id, folder.id]);
    expect(v.deliveries.map((d) => [d.outputProfileName, d.status])).toEqual([
      ["Paperless", "failed"],
      ["To folder", "sent"],
    ]);
    expect(h.outFiles()).toHaveLength(1);
    expect(await pdfPages(join(h.outDir, h.outFiles()[0]!))).toBe(2);
  } finally {
    paperless.stop(true);
  }
});

test("a failed resend keeps a delivered scan done (deliveries: sent, failed)", async () => {
  h = await makeHarness();
  const paperless = Bun.serve({ port: 0, fetch: () => new Response("boom", { status: 500, statusText: "Internal Server Error" }) });
  try {
    const bad = h.repo.saveOutput({
      name: "Paperless",
      format: "pdf_multi",
      jpegQuality: 80,
      filenameTemplate: "scan",
      destination: { type: "paperless", config: { url: `http://127.0.0.1:${paperless.port}`, token: "t" } },
    });
    const v0 = await h.svc.start(h.input().id, h.folderOutput().id, { review: false });
    await h.svc.settled(v0.id);
    expect(h.svc.get(v0.id)!.status).toBe("done");
    const v = await h.svc.resend(v0.id, bad.id);
    expect(v.status).toBe("done");
    expect(v.deliveries.map((d) => d.status)).toEqual(["sent", "failed"]);
    expect(v.deliveries[1]!.error).toContain("500");
  } finally {
    paperless.stop(true);
  }
});

test("undecryptable credentials -> delivery fails with 're-enter credentials', scan kept", async () => {
  h = await makeHarness();
  const p = h.repo.saveOutput({
    name: "Paperless",
    format: "pdf_multi",
    jpegQuality: 80,
    filenameTemplate: "scan",
    destination: { type: "paperless", config: { url: "http://127.0.0.1:1", token: "t" } },
  });
  h.db.query("UPDATE output_profiles SET destination_config = ? WHERE id = ?").run(JSON.stringify({ url: "http://127.0.0.1:1", token: "enc:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }), p.id);
  const v0 = await h.svc.start(h.input().id, p.id, { review: false });
  await h.svc.settled(v0.id);
  const v = h.svc.get(v0.id)!;
  expect(v.status).toBe("failed");
  expect(v.deliveries[0]!.error).toContain("re-enter credentials");
});

test("areaMm forces review and is sent to the service", async () => {
  h = await makeHarness();
  const fb = h.input({ source: "flatbed", paper: "glass" });
  const v0 = await h.svc.start(fb.id, h.folderOutput({ format: "png" }).id, { review: false, areaMm: [10, 20, 100, 50] });
  expect(v0.review).toBe(true);
  await h.svc.settled(v0.id);
  expect(h.svc.get(v0.id)!.status).toBe("review");
  expect(h.fake.requests.at(-1)).toEqual({ source: "flatbed", mode: "gray", dpi: 150, area_mm: [10, 20, 100, 50] });
  // "more" on a region scan scans the same region
  await h.svc.more(v0.id);
  await h.svc.settled(v0.id);
  expect(h.fake.requests.at(-1)).toMatchObject({ area_mm: [10, 20, 100, 50] });
});

test.skipIf(!magickAvailable())("preview() returns PNG bytes and stores nothing", async () => {
  h = await makeHarness();
  const png = await h.svc.preview();
  expect([...png.subarray(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
  expect(h.fake.requests.at(-1)).toEqual({ source: "flatbed", mode: "color", dpi: 75 });
  expect(h.svc.list(10)).toEqual([]);
  expect(h.fake.deleted).toHaveLength(1);
});

/** Mean R, G, B of the first page of a finished scan, as stored. */
async function pageMeans(h: Harness, scanId: string): Promise<number[]> {
  const { path } = h.db.query("SELECT path FROM pages WHERE scan_id = ?").get(scanId) as { path: string };
  return (await sharp(join(h.dataDir, path)).stats()).channels.map((c) => c.mean);
}
const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
/** Slightly cyan paper as the pipeline sees it without the device profile. */
const CYAN_WHITE: [number, number, number] = [236, 244, 250];
/** The scanner's raw white, which the device profile turns into near-white. */
const RAW_WHITE: [number, number, number] = [214, 234, 242];

test("white calibration asks for the middle of the glass, or an A4 sheet from the feeder", async () => {
  h = await makeHarness();
  h.fake.scenario = { pages: 0 };
  for (const source of ["flatbed", "adf"] as const) await h.services.calibration.calibrate(source).catch(() => {});
  expect(h.fake.requests).toMatchObject([
    { source: "flatbed", mode: "color", dpi: 150, area_mm: [88, 128, 40, 40] },
    { source: "adf", mode: "color", dpi: 75, paper: "a4" },
  ]);
});

test("white calibration without a page keeps the old calibration and deletes the job", async () => {
  h = await makeHarness();
  const old = { gains: [1, 1.1, 1.2] as [number, number, number], white: [200, 210, 220] as [number, number, number], at: 1 };
  h.settings.setWhiteBalance("adf", old);
  h.fake.scenario = { pages: 0 };
  await expect(h.services.calibration.calibrate("adf")).rejects.toThrow(StateError);
  expect(h.services.calibration.gains("adf")).toEqual(old.gains);
  expect(h.fake.deleted).toHaveLength(1);
});

describe.skipIf(!magickAvailable())("white calibration, without the device profile", () => {
  withoutDeviceIcc();

  test("the device profile is off here, so the tint reaches the calibration", async () => {
    expect(deviceIccPath()).toBeNull();
    h = await makeHarness();
    h.fake.scenario = { pages: 1, page: () => makeColourPnm(CYAN_WHITE) };
    const v = await h.svc.start(h.input({ source: "flatbed", paper: "glass", mode: "color" }).id, h.folderOutput({ format: "png" }).id, { review: false });
    await h.svc.settled(v.id);
    expect(spread(await pageMeans(h, v.id))).toBeGreaterThan(5);
  });

  test("white calibration: scans a patch, stores gains per source, colour pages come out neutral", async () => {
    h = await makeHarness();
    h.fake.scenario = { pages: 1, page: () => makeColourPnm(CYAN_WHITE) };
    const cal = await h.services.calibration.calibrate("flatbed");
    expect(h.fake.requests.at(-1)).toEqual({ source: "flatbed", mode: "color", dpi: 150, area_mm: [88, 128, 40, 40] });
    expect(Math.min(...cal.gains)).toBe(1);
    expect(Math.max(...cal.gains)).toBeGreaterThan(1);
    expect(h.settings.read().whiteBalance.flatbed).toEqual(cal);
    expect(h.settings.read().whiteBalance.adf).toBeUndefined();
    expect(h.svc.list(10)).toEqual([]); // not a scan in History
    expect(h.fake.deleted).toHaveLength(1);

    const v = await h.svc.start(h.input({ source: "flatbed", paper: "glass", mode: "color" }).id, h.folderOutput({ format: "png" }).id, { review: false });
    await h.svc.settled(v.id);
    expect(spread(await pageMeans(h, v.id))).toBeLessThanOrEqual(2);
  });

  test("white calibration refuses a patch that is not white and keeps the old one", async () => {
    h = await makeHarness();
    h.fake.scenario = { pages: 1, page: () => makeColourPnm([90, 100, 95]) };
    await expect(h.services.calibration.calibrate("flatbed")).rejects.toThrow("not white");
    expect(h.settings.read().whiteBalance).toEqual({});
  });

  test("feeder calibration scans a page from the feeder; reset removes it", async () => {
    h = await makeHarness();
    h.fake.scenario = { pages: 1, page: () => makeColourPnm(CYAN_WHITE, 150, 200) };
    await h.services.calibration.calibrate("adf");
    expect(h.fake.requests.at(-1)).toEqual({ source: "adf", mode: "color", dpi: 75, paper: "a4" });
    expect(h.settings.read().whiteBalance.adf).toBeDefined();
    h.services.calibration.clear("adf");
    expect(h.settings.read().whiteBalance).toEqual({});
  });
});

test.skipIf(!magickAvailable() || !deviceIccPath())("with the device profile, the scanner's raw white calibrates and comes out neutral", async () => {
  h = await makeHarness();
  h.fake.scenario = { pages: 1, page: () => makeColourPnm(RAW_WHITE) };
  const cal = await h.services.calibration.calibrate("flatbed");
  expect(Math.max(...cal.gains)).toBeGreaterThan(1);
  const v = await h.svc.start(h.input({ source: "flatbed", paper: "glass", mode: "color" }).id, h.folderOutput({ format: "png" }).id, { review: false });
  await h.svc.settled(v.id);
  expect(spread(await pageMeans(h, v.id))).toBeLessThanOrEqual(2);
});

test("flatbed + pdf_multi -> review even with review:false; 3x more -> 4 pages; send -> one 4-page PDF", async () => {
  h = await makeHarness();
  const fb = h.input({ source: "flatbed", paper: "glass" });
  const v0 = await h.svc.start(fb.id, h.folderOutput().id, { review: false });
  expect(v0.review).toBe(true);
  await h.svc.settled(v0.id);
  for (let i = 0; i < 3; i++) {
    await h.svc.more(v0.id);
    await h.svc.settled(v0.id);
  }
  expect(h.svc.get(v0.id)!.pages).toHaveLength(4);
  await h.svc.send(v0.id);
  expect(h.outFiles()).toHaveLength(1);
  expect(await pdfPages(join(h.outDir, h.outFiles()[0]!))).toBe(4);
});

test("scan filter gray + page 2 override bw; resend uses a changed scan filter", async () => {
  h = await makeHarness();
  h.fake.scenario = { pages: 3 };
  const v0 = await h.svc.start(h.input({ filter: { ...DEFAULT_FILTER, preset: "gray" } }).id, h.folderOutput({ filenameTemplate: "f" }).id, {
    review: true,
  });
  await h.svc.settled(v0.id);
  let v = h.svc.get(v0.id)!;
  expect(v.filter.preset).toBe("gray"); // starts with the input profile's filter
  v = await h.svc.setPageFilter(v.id, 2, { ...DEFAULT_FILTER, preset: "bw", threshold: 100 });
  expect(v.pages.map((p) => p.filter?.preset ?? null)).toEqual([null, "bw", null]);
  await h.svc.send(v.id);
  expect(await pdfImageBits(join(h.outDir, "f.pdf"))).toEqual([8, 1, 8]);
  await h.svc.setScanFilter(v.id, { ...DEFAULT_FILTER, preset: "bw" });
  await h.svc.resend(v.id, h.svc.get(v.id)!.outputProfileId!);
  expect(await pdfImageBits(join(h.outDir, "f-2.pdf"))).toEqual([1, 1, 1]);
  // clearing the override
  v = await h.svc.setPageFilter(v.id, 2, null);
  expect(v.pages[1]!.filter).toBeNull();
});

test("thumbnails exist and are re-rendered after a filter change", async () => {
  h = await makeHarness();
  h.fake.scenario = { pages: 1, page: () => makePnm("gray", 200, 100, 128) };
  const v0 = await h.svc.start(h.input().id, h.folderOutput().id, { review: true });
  await h.svc.settled(v0.id);
  const thumb = h.svc.thumbPath(v0.id, 1)!;
  const before = (await sharp(thumb).stats()).channels[0]!.mean;
  await h.svc.setScanFilter(v0.id, { ...DEFAULT_FILTER, brightness: 80 });
  const after = (await sharp(thumb).stats()).channels[0]!.mean;
  expect(after).toBeGreaterThan(before + 50);
  expect(h.svc.get(v0.id)!.pages[0]!.thumbUrl).toMatch(new RegExp(`^/api/scans/${v0.id}/pages/1/thumb\\?v=`));
});

test("cleanup(30) removes scans older than 30 days, keeps newer", async () => {
  let now = Date.UTC(2026, 9, 26);
  h = await makeHarness({ clock: () => now });
  const inp = h.input().id;
  const out = h.folderOutput({ format: "png" }).id;
  now -= 31 * 86400_000;
  const old = await h.svc.start(inp, out, { review: false });
  await h.svc.settled(old.id);
  now += 31 * 86400_000;
  const fresh = await h.svc.start(inp, out, { review: false });
  await h.svc.settled(fresh.id);
  expect(h.svc.cleanup(30)).toBe(1);
  expect(h.svc.get(old.id)).toBeNull();
  expect(existsSync(join(h.dataDir, "scans", old.id))).toBe(false);
  expect(h.svc.get(fresh.id)).not.toBeNull();
});

test("start fails fast with the client errors", async () => {
  h = await makeHarness();
  h.fake.printer = "off";
  await expect(h.svc.start(h.input().id, h.folderOutput().id, { review: false })).rejects.toBeInstanceOf(PrinterOff);
  h.fake.printer = "idle";
  h.fake.scenario = { pages: 2, pageDelayMs: 300 };
  const first = await h.svc.start(h.input().id, h.folderOutput().id, { review: false });
  await expect(h.svc.start(h.input().id, h.folderOutput().id, { review: false })).rejects.toBeInstanceOf(ScannerBusy);
  await h.svc.cancel(first.id);
  await h.svc.settled(first.id);
  expect(h.svc.get(first.id)!.status).toBe("cancelled");
  expect(h.svc.list(10).map((s) => s.id)).toEqual([first.id]);
});

test("list newest first with before-cursor; remove deletes rows and files", async () => {
  let now = 1_000_000;
  h = await makeHarness({ clock: () => (now += 1000) });
  const inp = h.input().id;
  const out = h.folderOutput({ format: "png" }).id;
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const v = await h.svc.start(inp, out, { review: false });
    await h.svc.settled(v.id);
    ids.push(v.id);
  }
  expect(h.svc.list(10).map((s) => s.id)).toEqual([...ids].reverse());
  const page1 = h.svc.list(2);
  expect(h.svc.list(10, page1.at(-1)!.createdAt).map((s) => s.id)).toEqual([ids[0]]);
  await h.svc.remove(ids[1]!);
  expect(h.svc.get(ids[1]!)).toBeNull();
  expect(existsSync(join(h.dataDir, "scans", ids[1]!))).toBe(false);
});

test("scans interrupted by a restart are not left 'scanning'", async () => {
  h = await makeHarness();
  h.db.query("INSERT INTO scans (id, created_at, input_profile, output_profile_id, status, page_count, review, filter) VALUES ('x', 1, ?, 1, 'scanning', 0, 0, NULL)").run(
    JSON.stringify(h.input()),
  );
  const { ScanService } = await import("../src/server/services/scan-service");
  const svc2 = new ScanService({ repo: new ScanRepo(h.db), profiles: h.profiles, settings: h.settings, calibration: h.services.calibration, client: h.client, hub: h.hub, dataDir: h.dataDir });
  expect(svc2.get("x")).toMatchObject({ status: "failed", error: "Interrupted by a restart" });
});

test("liveScans (WS snapshot) contains the scan in progress and the latest scan", async () => {
  h = await makeHarness();
  const out = h.folderOutput({ format: "png" }).id;
  const done = await h.svc.start(h.input().id, out, { review: false });
  await h.svc.settled(done.id);
  expect(h.svc.liveScans().map((s) => s.id)).toEqual([done.id]);
  h.fake.scenario = { pages: 2, pageDelayMs: 200 };
  const running = await h.svc.start(h.input().id, out, { review: false });
  const live = h.svc.liveScans();
  expect(live.map((s) => [s.id, s.status])).toEqual([[running.id, "scanning"]]);
  await h.svc.settled(running.id);
});

test("liveScans (WS snapshot) contains every scan waiting in the review tray", async () => {
  h = await makeHarness();
  const out = h.folderOutput({ format: "png" }).id;
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const v = await h.svc.start(h.input().id, out, { review: true });
    await h.svc.settled(v.id);
    ids.push(v.id);
  }
  const done = await h.svc.start(h.input().id, out, { review: false });
  await h.svc.settled(done.id);
  expect(h.svc.liveScans().map((s) => [s.id, s.status])).toEqual([...ids.map((id) => [id, "review"]), [done.id, "done"]]);
});

test("page view: large filtered JPEG, re-rendered after rotate and filter changes", async () => {
  h = await makeHarness();
  h.fake.scenario = { pages: 1, page: () => makePnm("gray", 2400, 1200, 128) };
  const v0 = await h.svc.start(h.input().id, h.folderOutput().id, { review: true });
  await h.svc.settled(v0.id);
  expect(h.svc.get(v0.id)!.pages[0]!.viewUrl).toMatch(new RegExp(`^/api/scans/${v0.id}/pages/1/view\\?v=`));
  let path = (await h.svc.pageView(v0.id, 1))!;
  let m = await sharp(path).metadata();
  expect([m.format, m.width, m.height]).toEqual(["jpeg", 1600, 800]); // long side capped at 1600
  await h.svc.rotate(v0.id, 1, 90);
  path = (await h.svc.pageView(v0.id, 1))!;
  m = await sharp(path).metadata();
  expect([m.width, m.height]).toEqual([800, 1600]);
  const before = (await sharp(path).stats()).channels[0]!.mean;
  await h.svc.setScanFilter(v0.id, { ...DEFAULT_FILTER, brightness: 80 });
  const after = (await sharp((await h.svc.pageView(v0.id, 1))!).stats()).channels[0]!.mean;
  expect(after).toBeGreaterThan(before + 50);
  expect(await h.svc.pageView(v0.id, 9)).toBeNull();
});

/** Presses the printer button and waits until a scan exists (or the timeout passes). */
async function press(format: "jpeg" | "tiff" | "pdf", wait = 2000): Promise<ScanView | undefined> {
  h.fake.pressButton({ button: 1, target: "application", format });
  const deadline = Date.now() + wait;
  while (Date.now() < deadline) {
    const [s] = h.svc.list(1);
    if (s) {
      await h.svc.settled(s.id);
      return h.svc.get(s.id)!;
    }
    await Bun.sleep(10);
  }
  return undefined;
}

test("button_starts_default_scan: the panel format picks the output profile, no review", async () => {
  h = await makeHarness();
  h.svc.listenToButton();
  h.fake.scenario = { pages: 2 };
  const input = h.input();
  const pdf = h.folderOutput({ name: "PDF to folder" });
  const tiff = h.folderOutput({ name: "TIFF to folder", format: "tiff_multi" });
  h.settingsRepo.write({ buttonInputProfileId: input.id, buttonOutputProfileIds: { pdf: pdf.id, tiff: tiff.id } });
  const v = (await press("tiff"))!;
  expect(v.inputProfile.id).toBe(input.id);
  expect(v.outputProfileId).toBe(tiff.id);
  expect(v.review).toBe(false);
  expect(v.status).toBe("done");
  expect(h.outFiles()[0]).toMatch(/\.tif$/);
});

test("button: an unmapped format falls back to the pdf mapping, then to any mapping", async () => {
  h = await makeHarness();
  h.svc.listenToButton();
  h.fake.scenario = { pages: 1 };
  const input = h.input();
  const pdf = h.folderOutput({ name: "PDF" });
  const jpeg = h.folderOutput({ name: "JPEG", format: "jpeg" });
  h.settingsRepo.write({ buttonInputProfileId: input.id, buttonOutputProfileIds: { pdf: pdf.id } });
  expect((await press("jpeg"))!.outputProfileId).toBe(pdf.id);
  h.close();

  h = await makeHarness();
  h.svc.listenToButton();
  h.fake.scenario = { pages: 1 };
  const input2 = h.input();
  const jpeg2 = h.folderOutput({ name: "JPEG", format: "jpeg" });
  h.settingsRepo.write({ buttonInputProfileId: input2.id, buttonOutputProfileIds: { jpeg: jpeg2.id } });
  expect((await press("tiff"))!.outputProfileId).toBe(jpeg2.id);
  expect(jpeg.id).toBeGreaterThan(0);
});

test("button with no defaults set starts nothing and tells the UI", async () => {
  h = await makeHarness();
  h.svc.listenToButton();
  expect(await press("pdf", 300)).toBeUndefined();
  expect(h.messages).toContainEqual({ type: "notice", message: "Printer button pressed, but no default profiles are set" });
});

test("button while the printer is off: the start error is reported, not swallowed", async () => {
  h = await makeHarness();
  h.svc.listenToButton();
  h.settingsRepo.write({ buttonInputProfileId: h.input().id, buttonOutputProfileIds: { pdf: h.folderOutput().id } });
  h.fake.setPrinter("off");
  h.fake.pressButton({ button: 1, target: "application", format: "pdf" });
  const deadline = Date.now() + 2000;
  while (!h.messages.some((m) => m.type === "notice") && Date.now() < deadline) await Bun.sleep(10);
  expect(h.messages.find((m) => m.type === "notice")).toEqual({ type: "notice", message: "Printer button: The printer is off" });
  expect(h.svc.list(1)).toHaveLength(0);
});

// ---------------------------------------------------------------- assistant (MCP) scans

test("ad-hoc scan: origin mcp, no output profile, ends ready, invisible while temporary", async () => {
  h = await makeHarness();
  h.fake.scenario = { pages: 1 };
  const v = await h.svc.startAdhoc(adhocProfile({ source: "flatbed", mode: "gray", dpi: 150 }), { store: false });
  await h.svc.settled(v.id);
  const got = h.svc.get(v.id, { includeTemporary: true })!;
  expect(got).toMatchObject({ status: "ready", origin: "mcp", temporary: true, outputProfileId: null });
  expect(got.pages).toHaveLength(1);
  expect(h.svc.get(v.id)).toBeNull();
  expect(h.svc.list().map((s) => s.id)).not.toContain(v.id);
  expect(h.svc.liveScans().map((s) => s.id)).not.toContain(v.id);
  expect(h.messages.some((m) => m.type === "scan" && m.scan.id === v.id)).toBe(false);
  expect(h.fake.requests.at(-1)).toMatchObject({ source: "flatbed", mode: "gray", dpi: 150 });
});

test("store makes it a normal history entry; send needs an output profile", async () => {
  h = await makeHarness();
  h.fake.scenario = { pages: 1 };
  const v = await h.svc.startAdhoc(adhocProfile({ source: "flatbed", mode: "gray", dpi: 150 }), { store: true });
  await h.svc.settled(v.id);
  expect(h.svc.get(v.id)).toMatchObject({ temporary: false, origin: "mcp", status: "ready" });
  expect(h.svc.list().map((s) => s.id)).toContain(v.id);
  await expect(h.svc.send(v.id)).rejects.toThrow("Choose an output profile");
  const sent = await h.svc.send(v.id, h.folderOutput().id);
  expect(sent.status).toBe("done");
  expect(sent.deliveries.map((d) => d.status)).toEqual(["sent"]);
});

test("store() on a temporary scan makes it visible and broadcasts it", async () => {
  h = await makeHarness();
  h.fake.scenario = { pages: 1 };
  const v = await h.svc.startAdhoc(adhocProfile({ source: "flatbed", mode: "gray", dpi: 150 }), { store: false });
  await h.svc.settled(v.id);
  const stored = h.svc.store(v.id);
  expect(stored.temporary).toBe(false);
  expect(h.svc.get(v.id)).not.toBeNull();
  expect(h.messages.some((m) => m.type === "scan" && m.scan.id === v.id)).toBe(true);
});

test("temporary scans expire after the shelf life; touch extends it", async () => {
  const t0 = 1_800_000_000_000;
  let now = t0;
  h = await makeHarness({ clock: () => now });
  h.fake.scenario = { pages: 1 };
  const v = await h.svc.startAdhoc(adhocProfile({ source: "flatbed", mode: "gray", dpi: 150 }), { store: false });
  await h.svc.settled(v.id);
  const MIN = 60_000;
  now = t0 + 59 * MIN;
  expect(h.svc.sweepTemporary()).toBe(0);
  h.svc.touch(v.id);
  now = t0 + 118 * MIN;
  expect(h.svc.sweepTemporary()).toBe(0);
  now = t0 + 120 * MIN;
  expect(h.svc.sweepTemporary()).toBe(1);
  expect(existsSync(join(h.dataDir, "scans", v.id))).toBe(false);
  expect(() => h.svc.mustGet(v.id)).toThrow("temporary scans expire after 60 minutes");
});

test("depth 16: colour only, sent to the service; depth 8 sends no depth", async () => {
  expect(() => adhocProfile({ source: "flatbed", mode: "gray", dpi: 300, depth: 16 })).toThrow("colour only");
  h = await makeHarness();
  h.fake.scenario = { pages: 1 };
  const a = await h.svc.startAdhoc(adhocProfile({ source: "flatbed", mode: "color", dpi: 75, depth: 16 }), { store: false });
  await h.svc.settled(a.id);
  expect(h.fake.requests.at(-1)).toMatchObject({ mode: "color", depth: 16 });
  const b = await h.svc.startAdhoc(adhocProfile({ source: "flatbed", mode: "color", dpi: 75 }), { store: false });
  await h.svc.settled(b.id);
  expect("depth" in h.fake.requests.at(-1)!).toBe(false);
});

test("a 16-bit input profile scans at 16 bits", async () => {
  h = await makeHarness();
  const inp = h.input({ source: "flatbed", paper: "glass", mode: "color", depth: 16 });
  const v = await h.svc.start(inp.id, h.folderOutput({ format: "png" }).id, { review: false });
  await h.svc.settled(v.id);
  expect(h.fake.requests.at(-1)).toMatchObject({ mode: "color", depth: 16 });
});

test("adhocProfile: defaults, base profile, validation", () => {
  const p = adhocProfile({ source: "adf", mode: "gray", dpi: 300 });
  expect(p).toMatchObject({ id: 0, name: "MCP scan", paper: "a4", autoOrient: false, threshold: 128, depth: 8, filter: DEFAULT_FILTER });
  expect(adhocProfile({ source: "flatbed", mode: "gray", dpi: 300 }).paper).toBe("glass");
  const base = { id: 7, name: "Docs", source: "adf" as const, mode: "gray" as const, dpi: 300 as const, paper: "letter" as const, autoOrient: true, threshold: 100, filter: DEFAULT_FILTER };
  expect(adhocProfile({ source: "adf", mode: "color", dpi: 600 }, base)).toMatchObject({ mode: "color", dpi: 600, paper: "letter", autoOrient: true, name: "MCP scan" });
  expect(() => adhocProfile({ source: "adf", mode: "gray", dpi: 123 as never })).toThrow();
});

test("more() works on a ready assistant scan", async () => {
  h = await makeHarness();
  h.fake.scenario = { pages: 1 };
  const v = await h.svc.startAdhoc(adhocProfile({ source: "flatbed", mode: "gray", dpi: 75 }), { store: false });
  await h.svc.settled(v.id);
  const m = await h.svc.more(v.id);
  expect(m.status).toBe("scanning");
  await h.svc.settled(v.id);
  expect(h.svc.get(v.id, { includeTemporary: true })).toMatchObject({ status: "ready" });
  expect(h.svc.get(v.id, { includeTemporary: true })!.pages).toHaveLength(2);
});

test("printer button scans are marked origin button", async () => {
  h = await makeHarness();
  h.fake.scenario = { pages: 1 };
  h.settingsRepo.write({ buttonInputProfileId: h.input().id, buttonOutputProfileIds: { pdf: h.folderOutput().id } });
  const v = (await h.svc.fromButton({ button: 1, target: "application", format: "pdf" }))!;
  await h.svc.settled(v.id);
  expect(h.svc.get(v.id)!.origin).toBe("button");
});

test.skipIf(!magickAvailable())("16-bit assistant scan stores 16-bit pages", async () => {
  h = await makeHarness();
  h.fake.scenario = { pages: 1 };
  const v = await h.svc.startAdhoc(adhocProfile({ source: "flatbed", mode: "color", dpi: 75, depth: 16 }), { store: true });
  await h.svc.settled(v.id);
  expect(h.svc.get(v.id)!.status).toBe("ready");
  const page = readdirSync(join(h.dataDir, "scans", v.id)).find((f) => /^page-\d+\.png$/.test(f))!;
  expect((await sharp(join(h.dataDir, "scans", v.id, page)).metadata()).depth).toBe("ushort");
});

test("pageImage and zoom: capped JPEGs at the right scale; glassArea refuses feeder pages", async () => {
  h = await makeHarness();
  h.fake.scenario = { pages: 1, width: 2400, height: 3200 };
  const v = await h.svc.startAdhoc(adhocProfile({ source: "flatbed", mode: "gray", dpi: 600 }), { store: false });
  await h.svc.settled(v.id);
  const img = await h.svc.pageImage(v.id, 1);
  const m = await sharp(img.jpeg).metadata();
  expect(m.format).toBe("jpeg");
  expect(Math.max(m.width!, m.height!)).toBeLessThanOrEqual(1568);
  expect(img.widthMm).toBeCloseTo(2400 * 25.4 / 600, 1);
  const z = await h.svc.zoom(v.id, 1, [0, 0, 2, 2]);
  expect(z.width).toBe(47);
  expect(z.pxPerMm).toBeCloseTo(600 / 25.4, 1);
  const zBig = await h.svc.zoom(v.id, 1, [0, 0, 100, 130]);
  expect(Math.max(zBig.width, zBig.height)).toBeLessThanOrEqual(1568);
  expect(h.svc.glassArea(v.id, 1, [10, 10, 20, 20])).toEqual([10, 10, 20, 20]);

  h.fake.scenario = { pages: 1 };
  const f = await h.svc.startAdhoc(adhocProfile({ source: "adf", mode: "gray", dpi: 150 }), { store: false });
  await h.svc.settled(f.id);
  expect(() => h.svc.glassArea(f.id, 1, [10, 10, 20, 20])).toThrow("feeder");
});

test("exportFiles: png gives one owned file per page, pdf_multi one, a page one PNG", async () => {
  h = await makeHarness();
  h.fake.scenario = { pages: 2 };
  const v = await h.svc.startAdhoc(adhocProfile({ source: "adf", mode: "gray", dpi: 75 }), { store: false });
  await h.svc.settled(v.id);
  const dir = (n: string) => join(h.dataDir, "exports", n);
  const png = await h.svc.exportFiles(v.id, { format: "png" }, dir("a"));
  expect(png).toHaveLength(2);
  expect(png.every((f) => f.owned && f.mime === "image/png" && existsSync(f.path))).toBe(true);
  const pdf = await h.svc.exportFiles(v.id, { format: "pdf_multi" }, dir("b"));
  expect(pdf.map((f) => f.mime)).toEqual(["application/pdf"]);
  const page = await h.svc.exportFiles(v.id, { page: 2 }, dir("c"));
  expect(page).toHaveLength(1);
  expect((await sharp(page[0]!.path).metadata()).format).toBe("png");
  await expect(h.svc.exportFiles(v.id, { page: 9 }, dir("d"))).rejects.toThrow("Page 9");
});

test("a region scan's view carries its area", async () => {
  h = await makeHarness();
  h.fake.scenario = { pages: 1 };
  const v = await h.svc.startAdhoc(adhocProfile({ source: "flatbed", mode: "gray", dpi: 75 }), { store: true, areaMm: [10, 20, 30, 40] });
  expect(v.area).toEqual([10, 20, 30, 40]);
  await h.svc.settled(v.id);
});

test("a finished batch restarts the shelf life, so a long scan is not swept right away", async () => {
  const t0 = 1_800_000_000_000;
  let now = t0;
  h = await makeHarness({ clock: () => now });
  h.fake.scenario = { pages: 1, pageDelayMs: 50 };
  const v = await h.svc.startAdhoc(adhocProfile({ source: "flatbed", mode: "gray", dpi: 75 }), { store: false });
  now = t0 + 59 * 60_000; // the batch "took" 59 minutes
  await h.svc.settled(v.id);
  now = t0 + 61 * 60_000;
  expect(h.svc.sweepTemporary()).toBe(0);
});

test("exports: leftovers are removed at startup; a failed export leaves no directory", async () => {
  h = await makeHarness();
  const left = join(h.dataDir, "exports", "old");
  mkdirSync(left, { recursive: true });
  writeFileSync(join(left, "x.pdf"), "x");
  const { ScanService } = await import("../src/server/services/scan-service");
  new ScanService({ repo: new ScanRepo(h.db), profiles: h.profiles, settings: h.settings, calibration: h.services.calibration, client: h.client, hub: h.hub, dataDir: h.dataDir });
  expect(existsSync(join(h.dataDir, "exports"))).toBe(false);
  h.fake.scenario = { pages: 1 };
  const v = await h.svc.startAdhoc(adhocProfile({ source: "flatbed", mode: "gray", dpi: 75 }), { store: true });
  await h.svc.settled(v.id);
  const dir = join(h.dataDir, "exports", "fail");
  await expect(h.svc.exportFiles(v.id, { page: 9 }, dir)).rejects.toThrow();
  expect(existsSync(dir)).toBe(false);
});

test("the first SFTP delivery stores the server's host key in the profile (trust on first use)", async () => {
  h = await makeHarness();
  const key = `SHA256:${"k".repeat(43)}`;
  const send = spyOn(sftp, "send").mockResolvedValue({ ref: "scan.pdf", learned: { hostKey: key } });
  try {
    const p = h.repo.saveOutput({
      name: "Server",
      format: "pdf_multi",
      jpegQuality: 80,
      filenameTemplate: "scan",
      destination: { type: "sftp", config: { host: "files.example", username: "u", password: "pw" } },
    });
    const v0 = await h.svc.start(h.input().id, p.id, { review: false });
    await h.svc.settled(v0.id);
    expect(h.svc.get(v0.id)!.status).toBe("done");
    expect(send).toHaveBeenCalledTimes(1);
    expect(h.repo.getOutput(p.id)!.destination.config).toMatchObject({ hostKey: key, password: "pw" });
  } finally {
    send.mockRestore();
  }
});
