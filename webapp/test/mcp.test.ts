import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { downloadHandler, DownloadStore } from "../src/server/downloads";
import { mcpHandler } from "../src/server/mcp/http";
import { captureLog } from "./helpers";
import { makeHarness, type Harness } from "./scan-harness";

let h: Harness;
let server: ReturnType<typeof Bun.serve> | null = null;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  server?.stop(true);
  server = null;
  h?.close();
});

async function setup(opts: { clock?: () => number } = {}) {
  const printer = {
    get: async () => ({
      supplies: [{ name: "Cyan Toner", color: "cyan", type: "toner", level: 8, low: true }],
      alerts: ["Front cover is open (077-300)"],
      severity: "error" as const,
      pageCount: 66098,
      readAt: Date.UTC(2026, 9, 27, 10, 24, 19),
      checkedAt: 1,
    }),
    refresh: async () => ({ supplies: [], alerts: [], severity: null, pageCount: 66099, readAt: Date.UTC(2026, 9, 27, 11, 0, 0), checkedAt: 2 }),
  };
  h = await makeHarness({ ...opts, printer });
  const key = h.settings.ensureMcpKey().mcpKey!;
  const downloads = new DownloadStore(opts);
  const deps = { services: h.services, downloads, dataDir: h.dataDir };
  const handle = mcpHandler(deps);
  const files = downloadHandler(downloads);
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => (new URL(req.url).pathname.startsWith("/files/") ? files(req) : handle(req)),
  });
  const url = `http://127.0.0.1:${server.port}/mcp/`;
  const connect = async (k = key) => {
    const c = new Client({ name: "test", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${k}` } } }));
    clients.push(c);
    return c;
  };
  const raw = (headers: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
    });
  return { key, url, deps, downloads, connect, raw };
}

test("initialize returns the instructions; tools are listed", async () => {
  const { connect } = await setup();
  const c = await connect();
  expect(c.getInstructions()).toContain("flatbed");
  expect(c.getInstructions()).toContain("get_download_links");
  const tools = (await c.listTools()).tools.map((t) => t.name);
  expect(tools).toContain("scanner_status");
});

test("wrong or missing key → 401 with WWW-Authenticate", async () => {
  const { raw } = await setup();
  const none = await raw();
  expect(none.status).toBe(401);
  expect(none.headers.get("www-authenticate")).toContain("Bearer");
  expect((await raw({ authorization: "Bearer 00000000-0000-4000-8000-000000000000" })).status).toBe(401);
});

test("MCP disabled → 404", async () => {
  const { raw, key } = await setup();
  h.settingsRepo.write({ mcpEnabled: false });
  expect((await raw({ authorization: `Bearer ${key}` })).status).toBe(404);
});

test("foreign Origin → 403; no Origin passes", async () => {
  const { raw, key } = await setup();
  expect((await raw({ authorization: `Bearer ${key}`, origin: "http://evil.example" })).status).toBe(403);
  expect((await raw({ authorization: `Bearer ${key}` })).status).toBe(200);
});

test("regenerated key: the old key gets 401", async () => {
  const { raw, key } = await setup();
  const fresh = h.settings.regenerateMcpKey().mcpKey!;
  expect((await raw({ authorization: `Bearer ${key}` })).status).toBe(401);
  expect((await raw({ authorization: `Bearer ${fresh}` })).status).toBe(200);
});

test("scanner_status reports the scanner and the feeder", async () => {
  const { connect } = await setup();
  h.fake.setPrinter("idle", true);
  await Bun.sleep(30);
  const c = await connect();
  const r = await c.callTool({ name: "scanner_status", arguments: {} });
  const body = JSON.parse((r.content as { text: string }[])[0]!.text);
  expect(body).toMatchObject({ service: "connected", printer: "idle", paperInFeeder: true });
  expect(body.printerReport).toEqual({
    alerts: ["Front cover is open (077-300)"],
    severity: "error",
    pageCount: 66098,
    supplies: [{ name: "Cyan Toner", color: "cyan", type: "toner", level: 8, low: true }],
    readAt: "2026-10-27T10:24:19.000Z",
  });
});

test("refresh_scanner_status wakes the printer for a fresh report; it is not read-only, scanner_status is", async () => {
  const { connect } = await setup();
  const c = await connect();
  const r = body(await c.callTool({ name: "refresh_scanner_status", arguments: {} }));
  expect(r).toMatchObject({ service: "connected" });
  expect(r.printerReport).toMatchObject({ pageCount: 66099, readAt: "2026-10-27T11:00:00.000Z" });
  const tools = new Map((await c.listTools()).tools.map((t) => [t.name, t.annotations]));
  expect(tools.get("scanner_status")?.readOnlyHint).toBe(true);
  expect(tools.get("refresh_scanner_status")?.readOnlyHint).toBeUndefined();
});

// ---------------------------------------------------------------- scanning tools

type Content = { type: string; text?: string; data?: string; mimeType?: string }[];
const content = (r: unknown) => (r as { content: Content }).content;
const text = (r: unknown) => content(r).find((c) => c.type === "text")!.text!;
const body = (r: unknown) => JSON.parse(text(r));
const images = (r: unknown) => content(r).filter((c) => c.type === "image");

test("scan (flatbed, gray 150) waits, returns ready + an image; temporary by default", async () => {
  const { connect } = await setup();
  h.fake.scenario = { pages: 1 };
  const c = await connect();
  const r = await c.callTool({ name: "scan", arguments: { source: "flatbed", mode: "gray", dpi: 150 } });
  expect(r.isError).toBeFalsy();
  const v = body(r);
  expect(v).toMatchObject({ status: "ready", origin: "mcp", temporary: true });
  expect(typeof v.expiresAt).toBe("string");
  expect(images(r).map((i) => i.mimeType)).toEqual(["image/jpeg"]);
  expect(h.svc.list().map((s) => s.id)).not.toContain(v.id);
  expect(h.fake.requests.at(-1)).toMatchObject({ source: "flatbed", mode: "gray", dpi: 150 });
});

test("scan with store: true appears in history; store_scan stores later", async () => {
  const { connect } = await setup();
  h.fake.scenario = { pages: 1 };
  const c = await connect();
  const a = body(await c.callTool({ name: "scan", arguments: { source: "flatbed", mode: "gray", dpi: 75, store: true } }));
  expect(h.svc.list().map((s) => s.id)).toContain(a.id);
  const b = body(await c.callTool({ name: "scan", arguments: { source: "flatbed", mode: "gray", dpi: 75 } }));
  expect(body(await c.callTool({ name: "store_scan", arguments: { scan_id: b.id } })).temporary).toBe(false);
  expect(h.svc.list().map((s) => s.id)).toContain(b.id);
});

test("scan options reach the scanner: area, depth 16, base input profile, filter", async () => {
  const { connect } = await setup();
  h.fake.scenario = { pages: 1 };
  const c = await connect();
  const base = h.input({ name: "Docs", source: "flatbed", paper: "glass", dpi: 300 });
  const v = body(
    await c.callTool({
      name: "scan",
      arguments: { input_profile_id: base.id, source: "flatbed", mode: "color", dpi: 75, depth: 16, area_mm: [10, 20, 30, 40], filter: { sharpen: "normal" } },
    }),
  );
  expect(h.fake.requests.at(-1)).toMatchObject({ mode: "color", dpi: 75, depth: 16, area_mm: [10, 20, 30, 40] });
  expect(v.filter.sharpen).toBe("normal");
  expect(v.inputProfile.depth).toBe(16);
  const bad = await c.callTool({ name: "scan", arguments: { source: "flatbed", mode: "gray", dpi: 75, depth: 16 } });
  expect(bad.isError).toBe(true);
  expect(text(bad)).toContain("colour only");
});

test("scan while busy → tool error mentioning busy", async () => {
  const { connect } = await setup();
  h.fake.scenario = { pages: 1, pageDelayMs: 2000 };
  const ui = await h.svc.start(h.input().id, h.folderOutput().id, { review: false });
  const c = await connect();
  const r = await c.callTool({ name: "scan", arguments: { source: "flatbed", mode: "gray", dpi: 75 } });
  expect(r.isError).toBe(true);
  expect(text(r)).toContain("busy");
  await h.svc.cancel(ui.id);
  await h.svc.settled(ui.id);
});

test("wait_seconds on a slow batch → state scanning + note; get_scan later shows ready", async () => {
  const { connect } = await setup();
  h.fake.scenario = { pages: 1, pageDelayMs: 1500 };
  const c = await connect();
  const v = body(await c.callTool({ name: "scan", arguments: { source: "flatbed", mode: "gray", dpi: 75, wait_seconds: 0.2 } }));
  expect(v.status).toBe("scanning");
  expect(v.note).toContain("get_scan");
  await h.svc.settled(v.id);
  expect(body(await c.callTool({ name: "get_scan", arguments: { scan_id: v.id } })).status).toBe("ready");
});

test("get_download_links pdf_multi → one link that works once", async () => {
  const { connect } = await setup();
  h.fake.scenario = { pages: 2 };
  const c = await connect();
  const v = body(await c.callTool({ name: "scan", arguments: { source: "adf", mode: "gray", dpi: 75 } }));
  const links = body(await c.callTool({ name: "get_download_links", arguments: { scan_id: v.id, format: "pdf_multi" } }));
  expect(links).toMatchObject({ scanId: v.id, format: "pdf_multi" });
  expect(links.files).toHaveLength(1);
  expect(links.files[0]).toMatchObject({ mime: "application/pdf" });
  const first = await fetch(links.files[0].url);
  expect(first.status).toBe(200);
  expect(new TextDecoder().decode((await first.arrayBuffer()).slice(0, 4))).toBe("%PDF");
  expect((await fetch(links.files[0].url)).status).toBe(410);
});

test("get_download_links png on 2 pages → a files array of 2 under one scanId; a single page → 1", async () => {
  const { connect } = await setup();
  h.fake.scenario = { pages: 2 };
  const c = await connect();
  const v = body(await c.callTool({ name: "scan", arguments: { source: "adf", mode: "gray", dpi: 75 } }));
  const png = body(await c.callTool({ name: "get_download_links", arguments: { scan_id: v.id, format: "png" } }));
  expect(png.scanId).toBe(v.id);
  expect(png.files.map((f: { mime: string }) => f.mime)).toEqual(["image/png", "image/png"]);
  expect(new Set(png.files.map((f: { url: string }) => f.url)).size).toBe(2);
  const page = body(await c.callTool({ name: "get_download_links", arguments: { scan_id: v.id, page: 2 } }));
  expect(page.files).toHaveLength(1);
});

test("page_image and zoom return images; preview returns the glass", async () => {
  const { connect } = await setup();
  h.fake.scenario = { pages: 1 };
  const c = await connect();
  const v = body(await c.callTool({ name: "scan", arguments: { source: "flatbed", mode: "gray", dpi: 150 } }));
  const pi = await c.callTool({ name: "page_image", arguments: { scan_id: v.id, page: 1 } });
  expect(images(pi)).toHaveLength(1);
  expect(body(pi).widthMm).toBeGreaterThan(0);
  const z = await c.callTool({ name: "zoom", arguments: { scan_id: v.id, page: 1, rect_mm: [0, 0, 5, 5] } });
  expect(images(z)).toHaveLength(1);
  expect(body(z).pxPerMm).toBeCloseTo(150 / 25.4, 1);
  const pv = await c.callTool({ name: "preview", arguments: {} });
  expect(images(pv)).toHaveLength(1);
  expect(body(pv).glassMm).toEqual([215.6, 296.8]);
});

test("page_area on a feeder page → tool error about the glass; on a flatbed page → region scan", async () => {
  const { connect } = await setup();
  h.fake.scenario = { pages: 1 };
  const c = await connect();
  const f = body(await c.callTool({ name: "scan", arguments: { source: "adf", mode: "gray", dpi: 75 } }));
  const bad = await c.callTool({ name: "scan", arguments: { source: "flatbed", mode: "gray", dpi: 600, page_area: { scan_id: f.id, page: 1, rect_mm: [1, 1, 5, 5] } } });
  expect(bad.isError).toBe(true);
  expect(text(bad)).toContain("glass");
  const fb = body(await c.callTool({ name: "scan", arguments: { source: "flatbed", mode: "gray", dpi: 75, area_mm: [20, 30, 50, 60] } }));
  await c.callTool({ name: "scan", arguments: { source: "flatbed", mode: "gray", dpi: 600, page_area: { scan_id: fb.id, page: 1, rect_mm: [1, 2, 5, 5] } } });
  expect(h.fake.requests.at(-1)).toMatchObject({ dpi: 600, area_mm: [21, 32, 5, 5] });
});

test("scan_more, cancel_scan and list_scans", async () => {
  const { connect } = await setup();
  h.fake.scenario = { pages: 1 };
  const c = await connect();
  const v = body(await c.callTool({ name: "scan", arguments: { source: "flatbed", mode: "gray", dpi: 75, store: true } }));
  const more = body(await c.callTool({ name: "scan_more", arguments: { scan_id: v.id } }));
  expect(more.pages).toHaveLength(2);
  const list = body(await c.callTool({ name: "list_scans", arguments: {} }));
  expect(list.map((s: { id: string }) => s.id)).toContain(v.id);
  expect(body(await c.callTool({ name: "cancel_scan", arguments: { scan_id: v.id } })).status).toBe("cancelled");
});

test("results never contain /api/ URLs", async () => {
  const { connect } = await setup();
  h.fake.scenario = { pages: 1 };
  const c = await connect();
  const v = body(await c.callTool({ name: "scan", arguments: { source: "flatbed", mode: "gray", dpi: 75, store: true } }));
  await h.svc.send(v.id, h.folderOutput().id);
  const g = await c.callTool({ name: "get_scan", arguments: { scan_id: v.id } });
  expect(JSON.stringify(g)).not.toContain("/api/");
  expect(body(g).deliveries[0].files.length).toBeGreaterThan(0);
});

test("an expired temporary scan gives a clear error", async () => {
  let now = 1_800_000_000_000;
  const { connect } = await setup({ clock: () => now });
  h.fake.scenario = { pages: 1 };
  const c = await connect();
  const v = body(await c.callTool({ name: "scan", arguments: { source: "flatbed", mode: "gray", dpi: 75 } }));
  now += 61 * 60_000;
  h.svc.sweepTemporary();
  const r = await c.callTool({ name: "get_scan", arguments: { scan_id: v.id } });
  expect(r.isError).toBe(true);
  expect(text(r)).toContain("expire");
});

// ---------------------------------------------------------------- review and administration tools

const paperless = (over: Record<string, unknown> = {}) => ({
  name: "Paperless",
  format: "pdf_multi",
  jpegQuality: 80,
  filenameTemplate: "scan",
  destination: { type: "paperless", config: { url: "http://paperless.example", token: "super-secret-token" } },
  ...over,
});

test("output profiles: secrets come back masked; saving the mask keeps the stored secret", async () => {
  const { connect } = await setup();
  const c = await connect();
  const created = await c.callTool({ name: "save_output_profile", arguments: { profile: paperless() } });
  expect(created.isError).toBeFalsy();
  expect(JSON.stringify(created)).not.toContain("super-secret-token");
  const id = body(created).id;
  const one = body(await c.callTool({ name: "get_output_profile", arguments: { id } }));
  expect(one.destination.config.token).toBe("••••");
  const listed = await c.callTool({ name: "list_output_profiles", arguments: {} });
  expect(JSON.stringify(listed)).not.toContain("super-secret-token");
  await c.callTool({ name: "save_output_profile", arguments: { profile: { ...one, name: "Renamed" } } });
  expect(h.repo.getOutputForUse(id).destination.config.token).toBe("super-secret-token");
  expect(h.repo.getOutput(id)!.name).toBe("Renamed");
  expect((await c.callTool({ name: "delete_output_profile", arguments: { id } })).isError).toBeFalsy();
  expect(h.repo.getOutput(id)).toBeNull();
});

test("get_settings has no MCP key; update_settings ignores the MCP switch", async () => {
  const { connect, key } = await setup();
  const c = await connect();
  const s = await c.callTool({ name: "get_settings", arguments: {} });
  expect(JSON.stringify(s)).not.toContain(key);
  expect(body(s)).not.toHaveProperty("mcpEnabled");
  expect(body(s).printerWakeHours).toBe(24);
  const u = body(
    await c.callTool({ name: "update_settings", arguments: { settings: { cleanupDays: 14, printerWakeHours: 6, mcpEnabled: false, mcpShelfLifeMinutes: 5 } } }),
  );
  expect(u).toMatchObject({ cleanupDays: 14, printerWakeHours: 6 });
  const tools = (await c.listTools()).tools.map((t) => t.name);
  expect(tools.some((t) => /mcp|key/i.test(t))).toBe(false);
  expect(h.settings.read()).toMatchObject({ mcpEnabled: true, mcpShelfLifeMinutes: 60 });
});

test("page tools and send_scan work on a ready assistant scan; sending stores it", async () => {
  const { connect } = await setup();
  h.fake.scenario = { pages: 2 };
  const c = await connect();
  const v = body(await c.callTool({ name: "scan", arguments: { source: "adf", mode: "gray", dpi: 75 } }));
  expect(body(await c.callTool({ name: "rotate_page", arguments: { scan_id: v.id, page: 1, degrees: 90 } })).pages[0].rotation).toBe(90);
  expect(body(await c.callTool({ name: "reorder_pages", arguments: { scan_id: v.id, order: [2, 1] } })).pages).toHaveLength(2);
  expect(body(await c.callTool({ name: "set_scan_filter", arguments: { scan_id: v.id, filter: { preset: "document" } } })).filter.preset).toBe("document");
  expect(body(await c.callTool({ name: "set_page_filter", arguments: { scan_id: v.id, page: 1, filter: { preset: "bw" } } })).pages[0].filter.preset).toBe("bw");
  expect(body(await c.callTool({ name: "remove_page", arguments: { scan_id: v.id, page: 2 } })).pages).toHaveLength(1);
  const sent = body(await c.callTool({ name: "send_scan", arguments: { scan_id: v.id, output_profile_id: h.folderOutput().id } }));
  expect(sent).toMatchObject({ status: "done", temporary: false });
  expect(h.outFiles()).toHaveLength(1);
  const again = body(await c.callTool({ name: "resend_scan", arguments: { scan_id: v.id, output_profile_id: h.folderOutput({ format: "png" }).id } }));
  expect(again.deliveries).toHaveLength(2);
});

test("delete_scan and cleanup_history remove scans", async () => {
  let now = 1_800_000_000_000;
  const { connect } = await setup({ clock: () => now });
  h.fake.scenario = { pages: 1 };
  const c = await connect();
  const a = body(await c.callTool({ name: "scan", arguments: { source: "flatbed", mode: "gray", dpi: 75, store: true } }));
  expect((await c.callTool({ name: "delete_scan", arguments: { scan_id: a.id } })).isError).toBeFalsy();
  expect(h.svc.get(a.id, { includeTemporary: true })).toBeNull();
  const b = body(await c.callTool({ name: "scan", arguments: { source: "flatbed", mode: "gray", dpi: 75, store: true } }));
  now += 10 * 86_400_000;
  expect(body(await c.callTool({ name: "cleanup_history", arguments: { older_than_days: 7 } })).removed).toBe(1);
  expect(h.svc.get(b.id)).toBeNull();
});

test("input profile CRUD round trip and common profiles", async () => {
  const { connect } = await setup();
  const c = await connect();
  const p = body(
    await c.callTool({
      name: "save_input_profile",
      arguments: { profile: { name: "Receipts", source: "flatbed", mode: "gray", dpi: 300, paper: "glass", autoOrient: true, threshold: 128 } },
    }),
  );
  expect(body(await c.callTool({ name: "get_input_profile", arguments: { id: p.id } })).name).toBe("Receipts");
  await c.callTool({ name: "save_input_profile", arguments: { profile: { ...p, dpi: 600 } } });
  expect(h.repo.getInput(p.id)!.dpi).toBe(600);
  const bad = await c.callTool({ name: "save_input_profile", arguments: { profile: { ...p, dpi: 123 } } });
  expect(bad.isError).toBe(true);
  await c.callTool({ name: "delete_input_profile", arguments: { id: p.id } });
  expect(h.repo.getInput(p.id)).toBeNull();
  const inputs = body(await c.callTool({ name: "list_input_profiles", arguments: {} }));
  expect(inputs.length).toBeGreaterThan(0);
  await c.callTool({ name: "delete_input_profile", arguments: { id: inputs[0].id } });
  expect(body(await c.callTool({ name: "add_common_profiles", arguments: {} })).input).toBe(1);
});

test("destructive tools are annotated", async () => {
  const { connect } = await setup();
  const c = await connect();
  const tools = new Map((await c.listTools()).tools.map((t) => [t.name, t.annotations]));
  for (const n of ["delete_scan", "cleanup_history", "delete_input_profile", "delete_output_profile", "remove_page"]) expect(tools.get(n)?.destructiveHint).toBe(true);
  for (const n of ["get_scan", "list_scans", "list_input_profiles", "get_settings", "page_image"]) expect(tools.get(n)?.readOnlyHint).toBe(true);
});

// ---------------------------------------------------------------- final review fixes

test("expired temporary scan: page_image, zoom and download links explain the expiry too", async () => {
  let now = 1_800_000_000_000;
  const { connect } = await setup({ clock: () => now });
  h.fake.scenario = { pages: 1 };
  const c = await connect();
  const v = body(await c.callTool({ name: "scan", arguments: { source: "flatbed", mode: "gray", dpi: 75 } }));
  now += 61 * 60_000;
  h.svc.sweepTemporary();
  for (const [name, args] of [
    ["page_image", { scan_id: v.id, page: 1 }],
    ["zoom", { scan_id: v.id, page: 1, rect_mm: [0, 0, 5, 5] }],
    ["get_download_links", { scan_id: v.id, format: "pdf_multi" }],
    ["scan", { source: "flatbed", mode: "gray", dpi: 600, page_area: { scan_id: v.id, page: 1, rect_mm: [1, 1, 5, 5] } }],
  ] as const) {
    const r = await c.callTool({ name, arguments: args as Record<string, unknown> });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("expire");
  }
});

test("the scan tools' default wait stays under the 60 s default MCP client timeout", async () => {
  const { DEFAULT_WAIT_SECONDS } = await import("../src/server/mcp/tools-scan");
  expect(DEFAULT_WAIT_SECONDS).toBeLessThanOrEqual(45);
});

test("page_image uses the same frame as zoom: auto-crop and straighten are not applied", async () => {
  const { connect } = await setup();
  const { makePnm } = await import("./fake-service");
  // A white page with a dark block in the middle: auto-crop would cut it down to the block.
  h.fake.scenario = {
    pages: 1,
    page: () => {
      const w = 200, h0 = 100;
      const pnm = makePnm("gray", w, h0, 255);
      const off = pnm.length - w * h0;
      for (let y = 40; y < 60; y++) for (let x = 90; x < 110; x++) pnm[off + y * w + x] = 0;
      return pnm;
    },
  };
  const c = await connect();
  const v = body(await c.callTool({ name: "scan", arguments: { source: "flatbed", mode: "gray", dpi: 75, filter: { autoCrop: true } } }));
  const pi = body(await c.callTool({ name: "page_image", arguments: { scan_id: v.id, page: 1 } }));
  expect(pi.width / pi.height).toBeCloseTo(pi.widthMm / pi.heightMm, 1);
});

test("scan: an input profile can supply source, mode and dpi", async () => {
  const { connect } = await setup();
  h.fake.scenario = { pages: 1 };
  const c = await connect();
  const base = h.input({ name: "Flatbed docs", source: "flatbed", paper: "glass", mode: "gray", dpi: 150 });
  const r = await c.callTool({ name: "scan", arguments: { input_profile_id: base.id } });
  expect(r.isError).toBeFalsy();
  expect(h.fake.requests.at(-1)).toMatchObject({ source: "flatbed", mode: "gray", dpi: 150 });
  const none = await c.callTool({ name: "scan", arguments: {} });
  expect(none.isError).toBe(true);
});

test("stored secrets never go to a host the assistant changed", async () => {
  const { connect } = await setup();
  const c = await connect();
  const id = body(await c.callTool({ name: "save_output_profile", arguments: { profile: paperless() } })).id;
  const masked = body(await c.callTool({ name: "get_output_profile", arguments: { id } }));
  const evil = { ...masked, destination: { type: "paperless", config: { ...masked.destination.config, url: "http://evil.example" } } };
  const save = await c.callTool({ name: "save_output_profile", arguments: { profile: evil } });
  expect(save.isError).toBe(true);
  expect(text(save)).toContain("enter the");
  expect(h.repo.getOutputForUse(id).destination.config.url).toBe("http://paperless.example");
  const t = await c.callTool({ name: "test_destination", arguments: { type: "paperless", config: evil.destination.config, id } });
  expect(t.isError).toBe(true);
  expect(text(t)).toContain("enter the");
  // Same host, masked token: still fine (rename keeps the secret).
  expect((await c.callTool({ name: "save_output_profile", arguments: { profile: { ...masked, name: "Renamed" } } })).isError).toBeFalsy();
});

// ---------------------------------------------------------------- deferred minors

test("send_scan with a bad output profile leaves a temporary scan temporary", async () => {
  const { connect } = await setup();
  h.fake.scenario = { pages: 1 };
  const c = await connect();
  const v = body(await c.callTool({ name: "scan", arguments: { source: "flatbed", mode: "gray", dpi: 75 } }));
  const r = await c.callTool({ name: "send_scan", arguments: { scan_id: v.id, output_profile_id: 9999 } });
  expect(r.isError).toBe(true);
  expect(h.svc.get(v.id, { includeTemporary: true })!.temporary).toBe(true);
});

test("a failing destination test is a plain tool error, not an internal one", async () => {
  const { connect } = await setup();
  const c = await connect();
  const r = await c.callTool({ name: "test_destination", arguments: { type: "folder", config: { path: "/nonexistent/scan-test-dir" } } });
  expect(r.isError).toBe(true);
  expect(text(r)).not.toContain("Internal error");
});

test("a scan that produced no pages is a tool error", async () => {
  const { connect } = await setup();
  h.fake.scenario = { pages: 0 };
  const c = await connect();
  const r = await c.callTool({ name: "scan", arguments: { source: "flatbed", mode: "gray", dpi: 75 } });
  expect(r.isError).toBe(true);
  expect(text(r)).toContain("failed");
});

test("a link to a delivered file whose scan was deleted answers 410", async () => {
  const { connect } = await setup();
  h.fake.scenario = { pages: 1 };
  const c = await connect();
  const v = body(await c.callTool({ name: "scan", arguments: { source: "flatbed", mode: "gray", dpi: 75, store: true } }));
  const sent = body(await c.callTool({ name: "send_scan", arguments: { scan_id: v.id, output_profile_id: h.folderOutput().id } }));
  const d = sent.deliveries[0];
  const links = body(await c.callTool({ name: "get_download_links", arguments: { scan_id: v.id, delivery_id: d.id, name: d.files[0].name } }));
  await h.svc.remove(v.id);
  const res = await fetch(links.files[0].url);
  expect(res.status).toBe(410);
});

test("forget_sftp_host forgets the SFTP host key trusted for host:port", async () => {
  const { connect } = await setup();
  h.services.hostKeys.set("nas.example", 22, `SHA256:${"a".repeat(43)}`);
  const c = await connect();
  const r = await c.callTool({ name: "forget_sftp_host", arguments: { host: "nas.example" } });
  expect(r.isError).toBeFalsy();
  expect(h.services.hostKeys.get("nas.example", 22)).toBeNull();
});

describe("log", () => {
  const lines = captureLog();

  test("a download link and a kept scan are logged, never the link or its key", async () => {
    const { connect } = await setup();
    h.fake.scenario = { pages: 1 };
    const c = await connect();
    const v = body(await c.callTool({ name: "scan", arguments: { source: "adf", mode: "gray", dpi: 75 } }));
    const links = body(await c.callTool({ name: "get_download_links", arguments: { scan_id: v.id, format: "pdf_multi" } }));
    await c.callTool({ name: "store_scan", arguments: { scan_id: v.id } });
    expect(lines).toContain(`INFO  mcp: download link for scan ${v.id}: 1 file(s), pdf_multi`);
    expect(lines).toContain(`INFO  scan: ${v.id} kept in History`);
    expect(lines.join("\n")).not.toContain(new URL(links.files[0].url).searchParams.get("key")!);
  });
});
