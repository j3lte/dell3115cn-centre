import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "@hono/zod-openapi";
import { hc } from "hono/client";
import { HTTPException } from "hono/http-exception";
import { AnalyseClient } from "../src/server/analyse-client";
import { isUuid } from "../src/server/db";
import { SMB_RETIRED } from "../src/server/destinations/smb";
import { createApp, type AppType } from "../src/server/http/app";
import { errorResponse } from "../src/server/http/errors";
import { exact } from "../src/server/http/schemas";
import { magickAvailable } from "../src/server/pipeline/magick";
import { ScanRepo } from "../src/server/repos/scan-repo";
import { makeColourPnm } from "./fake-service";
import { fakeFingerprint, scanInsert, withoutDeviceIcc } from "./helpers";
import { makeHarness, type Harness } from "./scan-harness";

let h: Harness;
afterEach(() => h?.close());

async function setup() {
  let mcpChanges = 0;
  h = await makeHarness({
    onMcpChange: () => mcpChanges++,
    printer: {
      get: async () => ({
        supplies: [{ name: "Black Toner", color: "black", type: "toner", level: 30, low: false }],
        alerts: ["Tray 1 is out of paper"],
        severity: "warning" as const,
        pageCount: 66098,
        readAt: 4,
        checkedAt: 5,
      }),
      refresh: async () => ({ supplies: [], alerts: [], severity: null, pageCount: 66099, readAt: 6, checkedAt: 6 }),
    },
  });
  h.settings.ensureMcpKey();
  const app = createApp(h.services);
  const api = (req: Request) => app.fetch(req);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await api(
      new Request(`http://app.local${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, headers: res.headers, body: type.includes("json") ? await res.json() : await res.arrayBuffer() };
  };
  return { api, call, mcpChanges: () => mcpChanges };
}

test("POST /api/scans 503 when printer off -> {error:'printer_off'}", async () => {
  const { call } = await setup();
  h.fake.printer = "off";
  const r = await call("POST", "/api/scans", { inputProfileId: h.input().id, outputProfileId: h.folderOutput().id, review: false });
  expect(r.status).toBe(503);
  expect(r.body.error).toBe("printer_off");
});

test("POST /api/scans 409 busy, 400 invalid body, 404 unknown profile", async () => {
  const { call } = await setup();
  h.fake.scenario = { pages: 1, pageDelayMs: 300 };
  const body = { inputProfileId: h.input().id, outputProfileId: h.folderOutput().id, review: false };
  const first = await call("POST", "/api/scans", body);
  expect(first.status).toBe(202);
  expect(first.body.status).toBe("scanning");
  expect((await call("POST", "/api/scans", body)).body.error).toBe("busy");
  expect((await call("POST", "/api/scans", { inputProfileId: "x" })).status).toBe(400);
  expect((await call("POST", "/api/scans", { ...body, inputProfileId: 999 })).status).toBe(404);
  await h.svc.settled(first.body.id);
});

test("output profile GET never contains the plain token; mask keeps it on PUT", async () => {
  const { call } = await setup();
  const created = await call("POST", "/api/output-profiles", {
    name: "Paperless",
    format: "pdf_multi",
    jpegQuality: 80,
    filenameTemplate: "scan",
    destination: { type: "paperless", config: { url: "http://paperless.example", token: "super-secret-token" } },
  });
  expect(created.status).toBe(201);
  expect(JSON.stringify(created.body)).not.toContain("super-secret-token");
  const list = await call("GET", "/api/output-profiles");
  expect(JSON.stringify(list.body)).not.toContain("super-secret-token");
  const one = await call("GET", `/api/output-profiles/${created.body.id}`);
  expect(one.body.destination.config.token).toBe("••••");
  const put = await call("PUT", `/api/output-profiles/${created.body.id}`, { ...one.body, name: "Renamed" });
  expect(put.status).toBe(200);
  expect(h.repo.getOutputForUse(created.body.id).destination.config.token).toBe("super-secret-token");
});

test("profile validation errors are 400 with a message", async () => {
  const { call } = await setup();
  const r = await call("POST", "/api/input-profiles", { name: "x", source: "flatbed", mode: "gray", dpi: 300, paper: "a4", autoOrient: false, threshold: 128 });
  expect(r.status).toBe(400);
  expect(r.body).toMatchObject({ error: "invalid" });
  expect(r.body.message).toContain("glass");
  const bad = await call("POST", "/api/output-profiles", {
    name: "f",
    format: "png",
    jpegQuality: 80,
    filenameTemplate: "x",
    destination: { type: "folder", config: { path: "relative" } },
  });
  expect(bad.status).toBe(400);
});

test("destination test endpoints", async () => {
  const { call } = await setup();
  const ok = await call("POST", "/api/destinations/test", { type: "folder", config: { path: h.outDir } });
  expect(ok).toMatchObject({ status: 200, body: { ok: true } });
  const fail = await call("POST", "/api/destinations/test", { type: "paperless", config: { url: "http://127.0.0.1:1", token: "t" } });
  expect(fail.status).toBe(422);
  expect(fail.body.error).toBe("test_failed");
  expect(fail.body.message).toContain("Cannot reach");
  const out = h.folderOutput();
  expect((await call("POST", `/api/output-profiles/${out.id}/test`)).body).toEqual({ ok: true });
});

test("testing a missing output profile answers 400 invalid", async () => {
  const { call } = await setup();
  const r = await call("POST", "/api/output-profiles/999999/test");
  expect(r.status).toBe(400);
  expect(r.body.error).toBe("invalid");
});

test("a profile id that is not a whole number answers 400 invalid", async () => {
  const { call } = await setup();
  for (const id of ["abc", "1.5"]) {
    const r = await call("GET", `/api/input-profiles/${id}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid");
  }
});

test("an input profile with a dpi that is not a number answers 400 invalid", async () => {
  const { call } = await setup();
  const r = await call("POST", "/api/input-profiles", { ...h.input(), id: undefined, name: "Bad dpi", dpi: "x" });
  expect(r.status).toBe(400);
  expect(r.body.error).toBe("invalid");
});

test("openapi.json documents the profile routes", async () => {
  const { call } = await setup();
  const { paths } = (await call("GET", "/api/openapi.json")).body;
  expect(paths["/api/output-profiles/{id}"].put).toBeDefined();
  for (const [path, methods] of Object.entries({
    "/api/input-profiles": ["get", "post"],
    "/api/input-profiles/{id}": ["get", "put", "delete"],
    "/api/output-profiles": ["get", "post"],
    "/api/output-profiles/{id}": ["get", "put", "delete"],
    "/api/output-profiles/{id}/test": ["post"],
    "/api/profiles/common": ["post"],
    "/api/destinations/test": ["post"],
  }))
    for (const m of methods) expect(paths[path]?.[m]).toBeDefined();
});

test("profile create and update keep their rules: id ignored on create, 404 before validation on update, needsCredentials dropped", async () => {
  const { call } = await setup();
  const draft = { ...h.input(), name: "Fresh", id: 4242 };
  const made = await call("POST", "/api/input-profiles", draft);
  expect(made.status).toBe(201);
  expect(made.body.id).not.toBe(4242);
  expect((await call("PUT", "/api/input-profiles/999999", { ...draft, name: "" })).status).toBe(404);
  expect((await call("PUT", `/api/input-profiles/${made.body.id}`, { ...draft, name: "Renamed" })).body.name).toBe("Renamed");
  const out = {
    name: "F",
    format: "png",
    jpegQuality: 80,
    filenameTemplate: "x",
    destination: { type: "folder", config: { path: h.outDir } },
  };
  const created = await call("POST", "/api/output-profiles", { ...out, id: 4242 });
  expect(created.status).toBe(201);
  expect(created.body.id).not.toBe(4242);
  expect((await call("PUT", "/api/output-profiles/999999", { ...out, name: "" })).status).toBe(404);
  // A client echoing needsCredentials can't make it stick: only an undecryptable stored secret sets it.
  const paperless = { ...out, destination: { type: "paperless", config: { url: "http://paperless.example", token: "t0k" } }, needsCredentials: true };
  const put = await call("PUT", `/api/output-profiles/${created.body.id}`, paperless);
  expect(put.status).toBe(200);
  expect(put.body.needsCredentials).toBeUndefined();
  expect((await call("GET", `/api/output-profiles/${created.body.id}`)).body.needsCredentials).toBeUndefined();
  expect((await call("DELETE", `/api/output-profiles/${created.body.id}`)).status).toBe(204);
});

test("scan endpoints: get, list, pages patch, filter, thumb, file download, delete", async () => {
  const { call } = await setup();
  h.fake.scenario = { pages: 2 };
  const started = await call("POST", "/api/scans", { inputProfileId: h.input().id, outputProfileId: h.folderOutput({ format: "png" }).id, review: true });
  await h.svc.settled(started.body.id);
  const id = started.body.id;
  expect((await call("GET", `/api/scans/${id}`)).body.status).toBe("review");
  expect((await call("GET", "/api/scans?limit=5")).body.map((s: any) => s.id)).toEqual([id]);
  const rotated = await call("PATCH", `/api/scans/${id}/pages`, { rotate: { n: 1, degrees: 90 } });
  expect(rotated.body.pages[0].rotation).toBe(90);
  const reordered = await call("PATCH", `/api/scans/${id}/pages`, { order: [2, 1] });
  expect(reordered.body.pages[1].rotation).toBe(90);
  expect((await call("PATCH", `/api/scans/${id}/pages`, { order: [1, 1] })).status).toBe(400);
  const filtered = await call("PUT", `/api/scans/${id}/filter`, { preset: "gray", threshold: 160, brightness: 0, contrast: 0, autoCrop: false, deskew: false });
  expect(filtered.body.filter.preset).toBe("gray");
  expect((await call("PUT", `/api/scans/${id}/filter`, { preset: "sepia" })).status).toBe(400);
  const pageFilter = await call("PATCH", `/api/scans/${id}/pages`, { filter: { n: 2, filter: null } });
  expect(pageFilter.status).toBe(200);
  const thumb = await call("GET", `/api/scans/${id}/pages/1/thumb`);
  expect(thumb.status).toBe(200);
  expect(thumb.headers.get("content-type")).toBe("image/jpeg");
  const view = await call("GET", `/api/scans/${id}/pages/1/view`);
  expect(view.status).toBe(200);
  expect(view.headers.get("content-type")).toBe("image/jpeg");
  expect((await call("GET", `/api/scans/${id}/pages/7/view`)).status).toBe(404);
  const sent = await call("POST", `/api/scans/${id}/send`, {});
  expect(sent.body.status).toBe("done");
  const file = sent.body.deliveries[0].files[0];
  expect(file.url).toBe(`/api/scans/${id}/deliveries/${sent.body.deliveries[0].id}/files/${encodeURIComponent(file.name)}`);
  const dl = await call("GET", file.url);
  expect(dl.status).toBe(200);
  expect(dl.headers.get("content-disposition")).toContain("attachment");
  expect((await call("GET", `/api/scans/${id}/deliveries/${sent.body.deliveries[0].id}/files/..%2Fdb.sqlite`)).status).toBe(404);
  expect((await call("DELETE", `/api/scans/${id}`)).status).toBe(204);
  expect((await call("GET", `/api/scans/${id}`)).status).toBe(404);
});

test("an unknown scan answers 404 before its body is checked; an assistant's temporary scan counts as unknown", async () => {
  const { call } = await setup();
  new ScanRepo(h.db).insertScan(scanInsert("tmp", { expires_at: Date.now() + 60_000, origin: "mcp" }));
  for (const id of ["nope", "tmp"])
    for (const [method, path, body] of [
      ["PATCH", `/api/scans/${id}/pages`, { rotate: { n: "x" } }],
      ["PUT", `/api/scans/${id}/filter`, { brightness: "x" }],
      ["POST", `/api/scans/${id}/send`, { outputProfileId: "x" }],
      ["POST", `/api/scans/${id}/resend`, { outputProfileId: "x" }],
    ] as const) {
      const r = await call(method, path, body);
      expect([path, r.status, r.body]).toEqual([path, 404, { error: "not_found", message: "Scan not found" }]);
    }
  // Another method on those paths is still a 405, known scan or not.
  expect((await call("GET", "/api/scans/nope/send")).status).toBe(405);
});

test("POST /api/scans with a malformed JSON body answers 400 invalid", async () => {
  const { api } = await setup();
  const res = await api(new Request("http://app.local/api/scans", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }));
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "invalid", message: "Request body must be a JSON object" });
});

test("POST /api/scans/:id/cancel without a body works", async () => {
  const { call } = await setup();
  h.fake.scenario = { pages: 1, pageDelayMs: 300 };
  const started = await call("POST", "/api/scans", { inputProfileId: h.input().id, outputProfileId: h.folderOutput().id, review: false });
  const r = await call("POST", `/api/scans/${started.body.id}/cancel`);
  expect(r.status).toBe(202);
  await h.svc.settled(started.body.id);
});

async function reviewScan(call: Awaited<ReturnType<typeof setup>>["call"]) {
  h.fake.scenario = { pages: 1 };
  const started = await call("POST", "/api/scans", { inputProfileId: h.input().id, outputProfileId: h.folderOutput({ format: "png" }).id, review: true });
  await h.svc.settled(started.body.id);
  return started.body.id as string;
}

test("send and resend accept a request without a body", async () => {
  const { api, call } = await setup();
  const id = await reviewScan(call);
  const empty = (path: string) => api(new Request(`http://app.local${path}`, { method: "POST" }));
  expect((await empty(`/api/scans/${id}/send`)).status).toBe(200);
  expect((await empty(`/api/scans/${id}/resend`)).status).toBe(200);
  expect((await call("POST", "/api/scans/nope/resend")).status).toBe(404);
  expect((await call("PATCH", "/api/scans/nope/pages", {})).status).toBe(404);
});

test("send and resend treat an empty JSON body as {}; a malformed one is 400 invalid", async () => {
  const { api, call } = await setup();
  const id = await reviewScan(call);
  const post = (path: string, body: string) =>
    api(new Request(`http://app.local${path}`, { method: "POST", headers: { "content-type": "application/json" }, body }));
  expect((await post(`/api/scans/${id}/send`, "")).status).toBe(200);
  expect((await post(`/api/scans/${id}/resend`, "")).status).toBe(200);
  expect((await post(`/api/scans/${id}/resend`, "  \n")).status).toBe(200);
  for (const path of [`/api/scans/${id}/send`, `/api/scans/${id}/resend`]) {
    const r = await post(path, "{");
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("invalid");
  }
});

test("resend without a body id and without a stored output profile → 400 'Choose an output profile'", async () => {
  const { call } = await setup();
  const id = await reviewScan(call);
  h.db.query("UPDATE scans SET output_profile_id = NULL WHERE id = ?").run(id);
  const r = await call("POST", `/api/scans/${id}/resend`, {});
  expect(r.status).toBe(400);
  expect(r.body.error).toBe("invalid");
  expect(r.body.message).toContain("Choose an output profile");
});

test("GET /api/scans?limit=x answers 200", async () => {
  const { call } = await setup();
  const r = await call("GET", "/api/scans?limit=x");
  expect(r.status).toBe(200);
  expect(Array.isArray(r.body)).toBe(true);
  expect(r.body.length).toBeLessThanOrEqual(20);
});

test("GET /api/scans?before=x answers 400 invalid", async () => {
  const { call } = await setup();
  const r = await call("GET", "/api/scans?before=x");
  expect(r.status).toBe(400);
  expect(r.body.error).toBe("invalid");
});

test("openapi.json documents the scan routes", async () => {
  const { call } = await setup();
  const spec = (await call("GET", "/api/openapi.json")).body;
  expect(spec.paths["/api/scans/{id}/pages"].patch).toBeDefined();
  expect(spec.paths["/api/scans"].post).toBeDefined();
});

test("status, connect and settings", async () => {
  const { call } = await setup();
  expect((await call("GET", "/api/status")).body).toMatchObject({ service: "connected", printer: "idle" });
  expect((await call("POST", "/api/connect")).status).toBe(202);
  const s = await call("GET", "/api/settings");
  expect(s.body).toMatchObject({ cleanupDays: null, buttonInputProfileId: null, buttonOutputProfileIds: {}, secretGenerated: true, generatedSecret: "gen-secret" });
  const put = await call("PUT", "/api/settings", { cleanupDays: 30 });
  expect(put.body.cleanupDays).toBe(30);
  expect((await call("PUT", "/api/settings", { cleanupDays: -1 })).status).toBe(400);
  const inp = h.input().id;
  const pdf = h.folderOutput().id;
  const tiff = h.folderOutput({ format: "tiff_multi" }).id;
  const button = await call("PUT", "/api/settings", { buttonInputProfileId: inp, buttonOutputProfileIds: { pdf, tiff } });
  expect(button.body).toMatchObject({ cleanupDays: 30, buttonInputProfileId: inp, buttonOutputProfileIds: { pdf, tiff } });
  expect((await call("PUT", "/api/settings", { buttonOutputProfileIds: { gif: pdf } })).status).toBe(400);
  expect((await call("PUT", "/api/settings", { buttonOutputProfileIds: { jpeg: 9999 } })).status).toBe(404);
  // clearing one format keeps the others
  const cleared = await call("PUT", "/api/settings", { buttonOutputProfileIds: { pdf, tiff: null } });
  expect(cleared.body.buttonOutputProfileIds).toEqual({ pdf });
  expect((await call("GET", "/api/nope")).status).toBe(404);
});

test("POST /api/profiles/common adds missing common profiles", async () => {
  const { call } = await setup();
  const before = (await call("GET", "/api/output-profiles")).body.length;
  const first = (await call("GET", "/api/output-profiles")).body.find((p: { name: string }) => p.name === "Download JPEG");
  await call("DELETE", `/api/output-profiles/${first.id}`);
  const r = await call("POST", "/api/profiles/common");
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ input: 0, output: 1 });
  expect((await call("GET", "/api/output-profiles")).body.length).toBe(before);
});

test("cross-site writes are refused: non-JSON bodies and foreign origins → 403 forbidden", async () => {
  const { api } = await setup();
  const send = (headers: Record<string, string>, body?: string, method = "POST", path = "/api/input-profiles") =>
    api(new Request(`http://app.local:8080${path}`, { method, headers: { host: "app.local:8080", ...headers }, body }));
  const draft = JSON.stringify({ ...h.input(), id: undefined, name: "Cross-site" });

  const plain = await send({ "content-type": "text/plain" }, draft);
  expect(plain.status).toBe(403);
  expect((await plain.json()).error).toBe("forbidden");
  expect((await send({ "content-type": "application/x-www-form-urlencoded" }, "", "DELETE", `/api/input-profiles/${h.input().id}`)).status).toBe(403);
  expect((await send({ "content-type": "application/json", origin: "https://evil.example" }, draft)).status).toBe(403);
  expect((await send({ origin: "https://evil.example" }, undefined, "POST", "/api/connect")).status).toBe(403);
  expect((await send({ "content-type": "application/json", origin: "null" }, draft)).status).toBe(403);

  // Same origin (any scheme, e.g. behind an HTTPS proxy) and curl (no Origin) keep working.
  expect((await send({ "content-type": "application/json", origin: "http://app.local:8080" }, draft)).status).toBe(201);
  expect((await send({ "content-type": "application/json; charset=utf-8", origin: "https://app.local:8080" }, draft.replace("Cross-site", "B"))).status).toBe(201);
  expect((await send({ "content-type": "application/json" }, draft.replace("Cross-site", "C"))).status).toBe(201);
  expect((await send({}, undefined, "POST", "/api/connect")).status).toBe(202);
  // Reads are not affected.
  expect((await send({ origin: "https://evil.example" }, undefined, "GET", "/api/status")).status).toBe(200);
});

test("settings: MCP fields, toggle, shelf life bounds, key regeneration", async () => {
  const { call, mcpChanges } = await setup();
  const s = (await call("GET", "/api/settings")).body;
  expect(s.mcpEnabled).toBe(true);
  expect(isUuid(s.mcpKey)).toBe(true);
  expect(s.mcpShelfLifeMinutes).toBe(60);
  expect((await call("PUT", "/api/settings", { mcpEnabled: false })).body.mcpEnabled).toBe(false);
  expect(mcpChanges()).toBe(1);
  expect((await call("PUT", "/api/settings", { mcpEnabled: "yes" })).status).toBe(400);
  expect((await call("PUT", "/api/settings", { mcpShelfLifeMinutes: 2 })).status).toBe(400);
  expect((await call("PUT", "/api/settings", { mcpShelfLifeMinutes: 1441 })).status).toBe(400);
  expect((await call("PUT", "/api/settings", { mcpShelfLifeMinutes: 120 })).body.mcpShelfLifeMinutes).toBe(120);
  const r = await call("POST", "/api/settings/mcp-key");
  expect(r.status).toBe(200);
  expect(isUuid(r.body.mcpKey)).toBe(true);
  expect(r.body.mcpKey).not.toBe(s.mcpKey);
  expect(mcpChanges()).toBe(2);
});

test("GET /api/printer returns supplies, alerts and the page count", async () => {
  const { call } = await setup();
  const r = await call("GET", "/api/printer");
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ alerts: ["Tray 1 is out of paper"], severity: "warning", pageCount: 66098, checkedAt: 5 });
  expect(r.body.supplies).toHaveLength(1);
});

test("a malformed %-escape in a delivery file name → 404", async () => {
  const { call } = await setup();
  expect((await call("GET", "/api/scans/x/deliveries/1/files/%E0%A4%A")).status).toBe(404);
});

test("a masked token is not reused when the profile now points at another host", async () => {
  const { call } = await setup();
  const created = await call("POST", "/api/output-profiles", {
    name: "Paperless",
    format: "pdf_multi",
    jpegQuality: 80,
    filenameTemplate: "scan",
    destination: { type: "paperless", config: { url: "http://paperless.example", token: "super-secret-token", tags: [1] } },
  });
  const one = (await call("GET", `/api/output-profiles/${created.body.id}`)).body;
  const moved = { ...one, destination: { type: "paperless", config: { ...one.destination.config, url: "http://elsewhere.example" } } };
  const put = await call("PUT", `/api/output-profiles/${created.body.id}`, moved);
  expect(put.status).toBe(400);
  expect(put.body.message).toContain("enter the token again");
  expect((await call("POST", "/api/destinations/test", { ...moved.destination, id: created.body.id })).status).toBe(400);
  // other changes keep the stored token
  const retag = { ...one, destination: { type: "paperless", config: { ...one.destination.config, tags: [2] } } };
  expect((await call("PUT", `/api/output-profiles/${created.body.id}`, retag)).status).toBe(200);
  expect(h.repo.getOutputForUse(created.body.id).destination.config.token).toBe("super-secret-token");
  // a new token for the new host is fine
  const fresh = { ...moved, destination: { type: "paperless", config: { ...moved.destination.config, token: "new-token" } } };
  expect((await call("PUT", `/api/output-profiles/${created.body.id}`, fresh)).status).toBe(200);
});

describe.skipIf(!magickAvailable())("without the device profile", () => {
  withoutDeviceIcc();

  test("white calibration endpoints: calibrate, show in settings, reset", async () => {
    const { call } = await setup();
    h.fake.scenario = { pages: 1, page: () => makeColourPnm([236, 244, 250], 60, 60) };
    const r = await call("POST", "/api/calibration/white", { source: "flatbed" });
    expect(r.status).toBe(200);
    expect(r.body.gains).toHaveLength(3);
    expect((await call("GET", "/api/settings")).body.whiteBalance.flatbed.gains).toEqual(r.body.gains);
    expect((await call("POST", "/api/calibration/white", { source: "glass" })).status).toBe(400);
    expect((await call("DELETE", "/api/calibration/white/flatbed")).status).toBe(204);
    expect(h.settings.read().whiteBalance).toEqual({});
    expect((await call("DELETE", "/api/calibration/white/glass")).status).toBe(400);
  });
});

test("POST /api/printer/refresh asks the printer for a fresh state", async () => {
  const { call } = await setup();
  const r = await call("POST", "/api/printer/refresh");
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ pageCount: 66099, checkedAt: 6 });
});

test("POST /api/printer/refresh?ifStale=true wakes the printer only when the last read is older than the setting", async () => {
  const { call } = await setup();
  const r = await call("POST", "/api/printer/refresh?ifStale=true");
  expect(r.status).toBe(200);
  expect(r.body.pageCount).toBe(66099); // the fake's last read (readAt 4) is decades old: woken
  h.settings.update({ printerWakeHours: null }, { allowMcp: false });
  expect((await call("POST", "/api/printer/refresh?ifStale=true")).body.pageCount).toBe(66098);
  expect((await call("POST", "/api/printer/refresh?ifStale=false")).body.pageCount).toBe(66099);
  expect((await call("POST", "/api/printer/refresh?ifStale=maybe")).status).toBe(400);
});

test("GET /api/openapi.json describes the API", async () => {
  const { call } = await setup();
  const r = await call("GET", "/api/openapi.json");
  expect(r.status).toBe(200);
  expect(r.body.openapi).toBe("3.1.0");
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(r.body.info).toEqual({ title: "Dell 3115cn Centre API", version: "1.0.0" });
  expect(r.body.paths["/api/status"].get).toBeDefined();
});

test("GET /api/docs serves the reference page", async () => {
  const { api } = await setup();
  const r = await api(new Request("http://app.local/api/docs"));
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toContain("text/html");
  const html = await r.text();
  expect(html).toContain("/api/docs/scalar.js");
  expect(html).toContain("/api/openapi.json");
  expect(html).not.toContain("cdn.jsdelivr.net");
});

test("GET /api/docs/scalar.js is served locally", async () => {
  const { api } = await setup();
  const r = await api(new Request("http://app.local/api/docs/scalar.js"));
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toContain("javascript");
  expect((await r.text()).length).toBeGreaterThan(100_000);
});

test("PUT /api/status → 405 method_not_allowed", async () => {
  const { call } = await setup();
  const r = await call("PUT", "/api/status", {});
  expect(r.status).toBe(405);
  expect(r.body).toEqual({ error: "method_not_allowed", message: "PUT not allowed" });
  // and for routes with a parameter
  expect((await call("PUT", "/api/scans")).body.error).toBe("method_not_allowed");
});

test("GET /api/nope → 404 not_found", async () => {
  const { call } = await setup();
  const r = await call("GET", "/api/nope");
  expect(r.status).toBe(404);
  expect(r.body).toEqual({ error: "not_found", message: "No route for /api/nope" });
});

test("unknown paths and methods answer 404 and 405", async () => {
  await setup();
  const app = createApp(h.services);
  const r404 = await app.fetch(new Request("http://app.local/api/nope"));
  expect(r404.status).toBe(404);
  expect(await r404.json()).toEqual({ error: "not_found", message: "No route for /api/nope" });
  const r405 = await app.fetch(new Request("http://app.local/api/printer/refresh"));
  expect(r405.status).toBe(405);
  expect(await r405.json()).toEqual({ error: "method_not_allowed", message: "GET not allowed" });
});

test("every route is documented", async () => {
  const { call } = await setup();
  const spec = (await call("GET", "/api/openapi.json")).body;
  const routes = createApp(h.services).routes.filter(
    (r) => r.method !== "ALL" && r.path.startsWith("/api") && !r.path.startsWith("/api/docs") && r.path !== "/api/openapi.json",
  );
  expect(routes.length).toBeGreaterThan(20);
  for (const r of routes) {
    const path = r.path.replace(/:(\w+)/g, "{$1}");
    expect(spec.paths[path]?.[r.method.toLowerCase()], `${r.method} ${path}`).toBeDefined();
  }
});

test("a failed request check answers 400 invalid with the first issue's path and message", async () => {
  const { newRouter } = await import("../src/server/http/router");
  const r = newRouter().openapi(
    {
      method: "post",
      path: "/x",
      request: { body: { content: { "application/json": { schema: z.object({ a: z.object({ b: z.number() }) }) } } } },
      responses: { 204: { description: "ok" } },
    },
    (c) => c.body(null, 204),
  );
  const post = (body: unknown) =>
    r.fetch(new Request("http://app.local/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  const nested = await post({ a: { b: "x" } });
  expect(nested.status).toBe(400);
  expect(await nested.json()).toEqual({ error: "invalid", message: "a.b: Invalid input: expected number, received string" });
  const root = await post([]);
  expect((await root.json()).message).toBe("Invalid input: expected object, received array");
});

test("a malformed JSON body (Hono's 400) answers 400 invalid", async () => {
  const r = errorResponse(new HTTPException(400, { message: "Malformed JSON in request body" }));
  expect(r.status).toBe(400);
  expect(await r.json()).toEqual({ error: "invalid", message: "Request body must be a JSON object" });
});

test("any other 400 from Hono keeps its own message", async () => {
  const r = errorResponse(new HTTPException(400, { message: "Malformed FormData request. boundary missing" }));
  expect(r.status).toBe(400);
  expect(await r.json()).toEqual({ error: "invalid", message: "Malformed FormData request. boundary missing" });
});

test("GET /api/scans clamps limit to 1..100 and falls back to 20 for 0, negative or non-numbers", async () => {
  const { call } = await setup();
  const repo = new ScanRepo(h.db);
  h.db.transaction(() => {
    for (let i = 0; i < 101; i++) repo.insertScan(scanInsert(`s${i}`, { created_at: i + 1 }));
  })();
  const count = async (limit: string) => (await call("GET", `/api/scans?limit=${limit}`)).body.length;
  expect((await call("GET", "/api/scans")).body.length).toBe(20);
  expect(await count("")).toBe(20);
  expect(await count("1")).toBe(1);
  expect(await count("100")).toBe(100);
  expect(await count("500")).toBe(100);
  expect(await count("0")).toBe(20);
  expect(await count("-5")).toBe(20);
  expect(await count("x")).toBe(20);
  expect(await count("1e1")).toBe(20);
  expect(await count("0x5")).toBe(20);
});

test("JSON answers are not cached", async () => {
  const { call } = await setup();
  expect((await call("GET", "/api/status")).headers.get("cache-control")).toBe("no-store");
  expect((await call("GET", "/api/printer")).headers.get("cache-control")).toBe("no-store");
});

// Type-level checks: a break shows up in `tsc`, not at runtime.
test("route types reach the client and response schemas match their domain types", () => {
  const client = hc<AppType>("http://app.local");
  expect(typeof client.api.status.$get).toBe("function");
  expect(typeof client.api.printer.refresh.$post).toBe("function");
  expect(typeof client.api["input-profiles"].$get).toBe("function");
  expect(typeof client.api["output-profiles"][":id"].$put).toBe("function");
  expect(typeof client.api.destinations.test.$post).toBe("function");
  expect(typeof client.api.scans[":id"].more.$post).toBe("function");
  expect(typeof client.api.settings.$get).toBe("function");
  expect(typeof client.api.calibration.white.$post).toBe("function");
  expect(typeof client.api.scans[":id"].pages[":n"].thumb.$get).toBe("function");
  // @ts-expect-error a schema that drifts from its domain type fails typecheck
  exact<{ a: string }>()(z.object({ a: z.number() }));
  exact<{ a: string; b?: number }>()(z.object({ a: z.string(), b: z.number().optional() }));
});

test("delivery file names are percent-decoded once", async () => {
  const { call } = await setup();
  h.fake.scenario = { pages: 1 };
  const started = await call("POST", "/api/scans", { inputProfileId: h.input().id, outputProfileId: h.folderOutput({ format: "png", filenameTemplate: "plain" }).id, review: true });
  await h.svc.settled(started.body.id);
  const sent = await call("POST", `/api/scans/${started.body.id}/send`, {});
  // the pipeline never writes a % into a name, so rename the stored record to one
  const stored = h.db.query("SELECT id, files FROM deliveries").get() as { id: number; files: string };
  const files = JSON.parse(stored!.files) as { name: string; path: string; mime: string }[];
  files[0]!.name = "100%.png";
  h.db.query("UPDATE deliveries SET files = ? WHERE id = ?").run(JSON.stringify(files), stored!.id);
  const base = `/api/scans/${started.body.id}/deliveries/${sent.body.deliveries[0].id}/files`;
  const dl = await call("GET", `${base}/100%25.png`);
  expect(dl.status).toBe(200);
  expect(dl.headers.get("content-disposition")).toContain(`filename="100%.png"`);
  expect((await call("GET", `${base}/%E0%A4%A`)).status).toBe(404);
});

test("PUT /api/settings with an empty body changes nothing", async () => {
  const { call, api } = await setup();
  const before = (await call("GET", "/api/settings")).body;
  const none = await call("PUT", "/api/settings");
  expect(none.status).toBe(200);
  expect(none.body).toEqual(before);
  const blank = await api(new Request("http://app.local/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: "" }));
  expect(blank.status).toBe(200);
  expect(await blank.json()).toEqual(before);
  const bad = await api(new Request("http://app.local/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: "{" }));
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toBe("invalid");
});

test("ids sent as digit strings are accepted like integers; other strings stay 400", async () => {
  const { call } = await setup();
  h.fake.scenario = { pages: 2 };
  const started = await call("POST", "/api/scans", { inputProfileId: String(h.input().id), outputProfileId: String(h.folderOutput({ format: "png" }).id), review: true });
  expect(started.status).toBe(202);
  await h.svc.settled(started.body.id);
  const id = started.body.id as string;
  const pages = (body: unknown) => call("PATCH", `/api/scans/${id}/pages`, body);
  expect((await pages({ rotate: { n: "1", degrees: "90" } })).status).toBe(200);
  expect((await pages({ order: ["2", "1"] })).status).toBe(200);
  expect((await pages({ filter: { n: "1", filter: null } })).status).toBe(200);
  expect((await pages({ remove: "7" })).status).toBe(404);
  for (const bad of ["1.5", "x", ""]) {
    expect((await pages({ rotate: { n: bad, degrees: 90 } })).status).toBe(400);
    expect((await call("POST", `/api/scans/${id}/send`, { outputProfileId: bad })).status).toBe(400);
    expect((await call("POST", "/api/destinations/test", { type: "folder", id: bad })).status).toBe(400);
  }
  expect((await call("POST", `/api/scans/${id}/send`, { outputProfileId: "99999" })).status).toBe(404);
  expect((await call("POST", "/api/destinations/test", { type: "paperless", config: { url: "http://127.0.0.1:1", token: "t" }, id: "99999" })).status).toBe(422);
  expect((await call("POST", `/api/scans/${id}/send`, { outputProfileId: String(h.folderOutput({ format: "png" }).id) })).status).toBe(200);
  expect((await call("POST", `/api/scans/${id}/resend`, { outputProfileId: String(h.folderOutput({ format: "png" }).id) })).status).toBe(200);
});

test("GET /api/features reports analyse off without a client and on with one", async () => {
  const { call } = await setup();
  expect((await call("GET", "/api/features")).body).toMatchObject({ analyse: false });
  h.services.analyse = new AnalyseClient("http://analyse.invalid");
  expect((await call("GET", "/api/features")).body).toMatchObject({ analyse: true });
});

test("SFTP host keys: read and forget the one trusted for host:port", async () => {
  const { call } = await setup();
  const services = h.services;
  expect((await call("GET", "/api/host-keys?host=nas.example&port=2222")).status).toBe(404);
  services.hostKeys.set("nas.example", 2222, fakeFingerprint("a"));
  const got = await call("GET", "/api/host-keys?host=nas.example&port=2222");
  expect(got.status).toBe(200);
  expect(got.body).toMatchObject({ host: "nas.example", port: 2222, fingerprint: fakeFingerprint("a") });
  expect(typeof got.body.firstSeen).toBe("number");
  expect((await call("GET", "/api/host-keys?host=nas.example")).status).toBe(404); // port 22 is another server
  expect((await call("GET", "/api/host-keys?host=nas.example&port=0")).status).toBe(400);
  expect((await call("DELETE", "/api/host-keys?host=nas.example&port=2222")).status).toBe(204);
  expect(services.hostKeys.get("nas.example", 2222)).toBeNull();
});

test("features list the retired destinations with their message", async () => {
  const { call } = await setup();
  expect((await call("GET", "/api/features")).body.retiredDestinations).toEqual({ smb: SMB_RETIRED });
});

test("destination tests pass a destination's note on", async () => {
  const { call } = await setup();
  const spy = spyOn(h.services.profiles, "testDestination").mockResolvedValue({ note: "left a file" });
  try {
    expect((await call("POST", "/api/destinations/test", { type: "folder", config: { path: h.outDir } })).body).toEqual({ ok: true, note: "left a file" });
  } finally {
    spy.mockRestore();
  }
});
