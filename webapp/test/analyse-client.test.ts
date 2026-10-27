import { afterEach, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { AnalyseClient, AnalyseFailed, AnalyseUnreachable, type DedaReport } from "../src/server/analyse-client";

const report: DedaReport = {
  found: true,
  dots: 120,
  gridScore: 0.9,
  dpi: 600,
  paperWhite: [250, 251, 249],
  decode: { Serial: "123456" },
  decodeError: null,
  images: { overview: "AAAA", closeRaw: "BBBB" },
};

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => server?.stop(true));

function serve(fetch: (req: Request) => Response | Promise<Response>) {
  server = Bun.serve({ port: 0, fetch });
  return `http://localhost:${server.port}`;
}

test("posts the page with dpi and parses the report", async () => {
  let seen: { url: string; type: string | null; accept: string | null; body: number[] } | undefined;
  const base = serve(async (req) => {
    seen = {
      url: new URL(req.url).pathname + new URL(req.url).search,
      type: req.headers.get("content-type"),
      accept: req.headers.get("accept-encoding"),
      body: [...new Uint8Array(await req.arrayBuffer())],
    };
    return Response.json(report);
  });
  const got = await new AnalyseClient(base).deda(new Uint8Array([1, 2, 3]), 600);
  expect(got).toEqual(report);
  expect(seen).toEqual({ url: "/deda/?dpi=600", type: "image/png", accept: expect.stringContaining("gzip") as unknown as string, body: [1, 2, 3] });
});

test("handles a gzip-encoded JSON answer", async () => {
  const base = serve(
    () => new Response(gzipSync(JSON.stringify(report)), { headers: { "content-type": "application/json", "content-encoding": "gzip" } }),
  );
  expect(await new AnalyseClient(base).deda(new Uint8Array([1]), 600)).toEqual(report);
});

test("non-2xx becomes AnalyseFailed with the body's message", async () => {
  const base = serve(() => Response.json({ error: "invalid", message: "not a PNG" }, { status: 400 }));
  const err = await new AnalyseClient(base).deda(new Uint8Array([1]), 600).catch((e) => e);
  expect(err).toBeInstanceOf(AnalyseFailed);
  expect(err.message).toBe("not a PNG");
});

test("non-JSON error body falls back to the status", async () => {
  const base = serve(() => new Response("boom", { status: 502 }));
  const err = await new AnalyseClient(base).deda(new Uint8Array([1]), 600).catch((e) => e);
  expect(err).toBeInstanceOf(AnalyseFailed);
  expect(err.message).toContain("502");
});

test("a closed port is AnalyseUnreachable", async () => {
  const base = serve(() => Response.json(report));
  server!.stop(true);
  const err = await new AnalyseClient(base).deda(new Uint8Array([1]), 600).catch((e) => e);
  expect(err).toBeInstanceOf(AnalyseUnreachable);
});

test("a slow service times out as AnalyseFailed", async () => {
  const base = serve(async () => {
    await Bun.sleep(1000);
    return Response.json(report);
  });
  const err = await new AnalyseClient(base, { timeoutMs: 50 }).deda(new Uint8Array([1]), 600).catch((e) => e);
  expect(err).toBeInstanceOf(AnalyseFailed);
  expect(err.message).toMatch(/^timed out after /);
});

test("the caller's signal aborts the request", async () => {
  const base = serve(async () => {
    await Bun.sleep(1000);
    return Response.json(report);
  });
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 30);
  const err = await new AnalyseClient(base).deda(new Uint8Array([1]), 600, ctl.signal).catch((e) => e);
  expect(err).toBeInstanceOf(AnalyseFailed);
  expect(err.message).not.toMatch(/timed out/);
});
