import { afterEach, describe, expect, test } from "bun:test";
import { AnalyseClient, type DedaReport } from "../src/server/analyse-client";
import { createApp } from "../src/server/http/app";
import { withoutDeviceIcc } from "./helpers";
import { makeHarness, type Harness } from "./scan-harness";

let h: Harness;
afterEach(() => h?.close());

const b64 = (s: string) => Buffer.from(s).toString("base64");
const REPORT: DedaReport = {
  found: true,
  dots: 5,
  gridScore: 0.9,
  dpi: 600,
  paperWhite: [250, 250, 250],
  decode: { serial: "123456" },
  decodeError: null,
  images: { overview: b64("overview-png"), closeRaw: b64("raw-png") },
};
const client = () =>
  new AnalyseClient("http://analyse.test", { fetchImpl: (async () => Response.json(REPORT)) as unknown as typeof fetch });

async function setup(configured = true) {
  h = await makeHarness(configured ? { analyse: client() } : {});
  h.fake.scenario = { pages: 1 };
  const app = createApp(h.services);
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.fetch(
      new Request(`http://app.local${path}`, {
        method,
        headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, headers: res.headers, body: type.includes("json") ? await res.json() : await res.arrayBuffer() };
  };
  return call;
}

async function storedScan(dpi: 200 | 300 | 600 = 600, mode: "color" | "gray" = "color"): Promise<string> {
  const v = await h.svc.start(h.input({ source: "flatbed", paper: "glass", mode, dpi }).id, h.folderOutput().id, { review: true });
  await h.svc.settled(v.id);
  return v.id;
}

describe("analyse API: not configured", () => {
  test("every route answers 404 not_found", async () => {
    const call = await setup(false);
    const routes: [string, string, unknown?][] = [
      ["GET", "/api/analyse/deda"],
      ["GET", "/api/analyse/deda/candidates"],
      ["POST", "/api/analyse/deda/scan"],
      ["POST", "/api/analyse/deda", { scanId: "x", page: 1 }],
      ["PATCH", "/api/analyse/deda/x", { name: "n" }],
      ["DELETE", "/api/analyse/deda/x"],
      ["DELETE", "/api/analyse/deda"],
      ["GET", "/api/analyse/deda/x/images/overview"],
    ];
    for (const [m, p, b] of routes) {
      const r = await call(m, p, b);
      expect([m, p, r.status, r.body.error]).toEqual([m, p, 404, "not_found"]);
    }
  });
});

describe("analyse API", () => {
  withoutDeviceIcc();

  test("history analysis end to end: start, list, image, rename, delete", async () => {
    const call = await setup();
    expect((await call("GET", "/api/analyse/deda")).body).toEqual({ analyses: [] });
    const scanId = await storedScan();

    const started = await call("POST", "/api/analyse/deda", { scanId, page: 1 });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ status: "analysing", source: "history", scanId, page: 1, dpi: 600 });
    await h.services.deda!.idle();

    const list = await call("GET", "/api/analyse/deda");
    expect(list.status).toBe(200);
    expect(list.body.analyses).toHaveLength(1);
    expect(list.body.analyses[0]).toMatchObject({ id: started.body.id, status: "done", found: true, dots: 5, decode: { serial: "123456" } });

    const img = await call("GET", `/api/analyse/deda/${started.body.id}/images/overview`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(img.body as ArrayBuffer).toString()).toBe("overview-png");
    // not produced for this entry, or not a known name
    for (const n of ["closeYellow", "..%2F..%2Fdb.sqlite", "nope"]) expect((await call("GET", `/api/analyse/deda/${started.body.id}/images/${n}`)).status).toBe(404);
    expect((await call("GET", "/api/analyse/deda/nope/images/overview")).status).toBe(404);

    const renamed = await call("PATCH", `/api/analyse/deda/${started.body.id}`, { name: "  My page " });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe("My page");
    expect((await call("PATCH", `/api/analyse/deda/${started.body.id}`, { name: "  " })).status).toBe(400);
    expect((await call("PATCH", `/api/analyse/deda/${started.body.id}`, {})).status).toBe(400);
    expect((await call("PATCH", "/api/analyse/deda/nope", { name: "x" })).status).toBe(404);

    expect((await call("DELETE", `/api/analyse/deda/${started.body.id}`)).status).toBe(204);
    expect((await call("DELETE", `/api/analyse/deda/${started.body.id}`)).status).toBe(404);
    expect((await call("GET", "/api/analyse/deda")).body).toEqual({ analyses: [] });
  });

  test("POST validates the page", async () => {
    const call = await setup();
    const gray = await storedScan(600, "gray");
    const low = await storedScan(200);
    expect((await call("POST", "/api/analyse/deda", { scanId: gray, page: 1 })).status).toBe(400);
    expect((await call("POST", "/api/analyse/deda", { scanId: low, page: 1 })).status).toBe(400);
    expect((await call("POST", "/api/analyse/deda", { scanId: low, page: 9 })).status).toBe(404);
    expect((await call("POST", "/api/analyse/deda", { scanId: "nope", page: 1 })).status).toBe(404);
    expect((await call("POST", "/api/analyse/deda", { scanId: low })).status).toBe(400);
    expect((await call("GET", "/api/analyse/deda")).body).toEqual({ analyses: [] });
  });

  test("POST /scan starts a flatbed analysis", async () => {
    const call = await setup();
    const r = await call("POST", "/api/analyse/deda/scan");
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ source: "scan", status: "scanning" });
    await h.services.deda!.idle();
    expect((await call("GET", "/api/analyse/deda")).body.analyses[0]).toMatchObject({ id: r.body.id, status: "done" });
  });

  test("DELETE all answers how many were removed", async () => {
    const call = await setup();
    const scanId = await storedScan();
    await call("POST", "/api/analyse/deda", { scanId, page: 1 });
    await call("POST", "/api/analyse/deda", { scanId, page: 1 });
    await h.services.deda!.idle();
    expect(await call("DELETE", "/api/analyse/deda")).toMatchObject({ status: 200, body: { removed: 2 } });
    expect((await call("DELETE", "/api/analyse/deda")).body).toEqual({ removed: 0 });
  });

  test("candidates", async () => {
    const call = await setup();
    await storedScan(200);
    await storedScan(600, "gray");
    const mid = await storedScan(300);
    const good = await storedScan(600);
    const r = await call("GET", "/api/analyse/deda/candidates");
    expect(r.status).toBe(200);
    expect(r.body.scans.map((s: { id: string }) => s.id)).toEqual([good, mid]);
    expect(r.body.scans[0]).toMatchObject({ id: good, pages: [{ n: 1, dpi: 600, mode: "color", lowDpi: false }] });
    expect(r.body.scans[1].pages).toEqual([{ n: 1, dpi: 300, mode: "color", lowDpi: true }]);
  });

  test("cross-site writes are refused with 403", async () => {
    const call = await setup();
    const evil = { origin: "http://evil.example" };
    for (const [m, p, b] of [
      ["POST", "/api/analyse/deda/scan"],
      ["POST", "/api/analyse/deda", { scanId: "x", page: 1 }],
      ["PATCH", "/api/analyse/deda/x", { name: "n" }],
      ["DELETE", "/api/analyse/deda/x"],
      ["DELETE", "/api/analyse/deda"],
    ] as [string, string, unknown?][]) {
      const r = await call(m, p, b, evil);
      expect([m, p, r.status, r.body.error]).toEqual([m, p, 403, "forbidden"]);
    }
    expect((await call("GET", "/api/analyse/deda")).body).toEqual({ analyses: [] });
  });

  test("openapi lists the routes", async () => {
    const call = await setup();
    const doc = (await call("GET", "/api/openapi.json")).body;
    expect(Object.keys(doc.paths).filter((p) => p.startsWith("/api/analyse")).sort()).toEqual([
      "/api/analyse/deda",
      "/api/analyse/deda/candidates",
      "/api/analyse/deda/scan",
      "/api/analyse/deda/{id}",
      "/api/analyse/deda/{id}/images/{name}",
    ]);
    expect(Object.keys(doc.paths["/api/analyse/deda"]).sort()).toEqual(["delete", "get", "post"]);
  });
});
