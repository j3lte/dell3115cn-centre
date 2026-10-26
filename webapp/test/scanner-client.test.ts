import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InvalidScan, PrinterOff, ScannerBusy, ScannerClient, ServiceUnreachable, type ScannerStatus } from "../src/server/scanner-client";
import { FakeScannerService } from "./fake-service";
import { tmpdir } from "./helpers";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup(opts: { backoffMs?: number[] } = { backoffMs: [50, 50] }) {
  const fake = new FakeScannerService().start();
  const client = new ScannerClient(fake.url, opts);
  cleanups.push(() => {
    client.stop();
    fake.stop();
  });
  return { fake, client };
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await Bun.sleep(5);
  }
}

test("status goes connecting -> connected with printer idle", async () => {
  const { client } = setup();
  const seen: ScannerStatus[] = [];
  client.onStatus((s) => seen.push(s));
  expect(client.status.service).toBe("connecting");
  client.start();
  await until(() => client.status.service === "connected");
  expect(client.status).toEqual({ service: "connected", printer: "idle", paperInFeeder: false });
  expect(seen.at(-1)!.service).toBe("connected");
});

test("live status changes arrive (printer off, paper in feeder)", async () => {
  const { fake, client } = setup();
  client.start();
  await until(() => client.status.service === "connected");
  fake.setPrinter("idle", true);
  await until(() => client.status.paperInFeeder);
  fake.setPrinter("off", false);
  await until(() => client.status.printer === "off");
});

test("unreachable when the service stops, connected again when it returns", async () => {
  const { fake, client } = setup();
  client.start();
  await until(() => client.status.service === "connected");
  fake.stop();
  await until(() => client.status.service === "unreachable", 500);
  expect(client.status.printer).toBeNull();
  fake.start();
  await until(() => client.status.service === "connected", 1000);
});

test("reconnectNow skips the backoff wait", async () => {
  const { fake, client } = setup({ backoffMs: [60_000] });
  client.start();
  await until(() => client.status.service === "connected");
  fake.stop();
  await until(() => client.status.service === "unreachable");
  fake.start();
  await Bun.sleep(100);
  expect(client.status.service).toBe("unreachable");
  client.reconnectNow();
  await until(() => client.status.service === "connected", 1000);
});

test("silent connection (no data) is treated as lost after the idle timeout", async () => {
  // A server that accepts the SSE request and then never sends anything.
  const silent = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(": hello\n\n")); } }), { headers: { "content-type": "text/event-stream" } }),
  });
  const client = new ScannerClient(`http://127.0.0.1:${silent.port}`, { backoffMs: [50], idleTimeoutMs: 100 });
  cleanups.push(() => {
    client.stop();
    silent.stop(true);
  });
  client.start();
  await until(() => client.status.service === "unreachable", 1000);
});

test("button events are forwarded", async () => {
  const { fake, client } = setup();
  const pressed: unknown[] = [];
  client.onButton((b) => pressed.push(b));
  client.start();
  await until(() => client.status.service === "connected");
  fake.pressButton({ button: 1, target: "application", format: "tiff" });
  await until(() => pressed.length === 1);
  expect(pressed).toEqual([{ button: 1, target: "application", format: "tiff" }]);
});

test("startScan maps 409 busy, 503 printer off, 400 invalid", async () => {
  const { fake, client } = setup();
  fake.scenario = { pages: 2, pageDelayMs: 200 };
  const id = await client.startScan({ source: "adf", mode: "gray", dpi: 75 });
  expect(typeof id).toBe("string");
  expect(fake.requests.at(-1)).toEqual({ source: "adf", mode: "gray", dpi: 75 });
  await expect(client.startScan({ source: "adf", mode: "gray", dpi: 75 })).rejects.toBeInstanceOf(ScannerBusy);
  await client.cancel(id);
  for await (const _ of client.jobEvents(id));
  fake.printer = "off";
  await expect(client.startScan({ source: "adf", mode: "gray", dpi: 75 })).rejects.toBeInstanceOf(PrinterOff);
  fake.printer = "idle";
  const err = await client.startScan({ source: "adf", mode: "gray", dpi: 123 as any }).catch((e) => e);
  expect(err).toBeInstanceOf(InvalidScan);
  expect(err.message).toContain("dpi");
});

test("startScan against a dead service throws ServiceUnreachable", async () => {
  const { fake, client } = setup();
  fake.stop();
  await expect(client.startScan({ source: "adf", mode: "gray", dpi: 75 })).rejects.toBeInstanceOf(ServiceUnreachable);
});

test("jobEvents yields 2 pages then done; fetchPage returns P5 bytes", async () => {
  const { fake, client } = setup();
  fake.scenario = { pages: 2 };
  const id = await client.startScan({ source: "adf", mode: "gray", dpi: 75 });
  const events = [];
  for await (const e of client.jobEvents(id)) events.push(e);
  expect(events).toEqual([
    { type: "page", n: 1, width: 120, height: 170, mode: "gray" },
    { type: "page", n: 2, width: 120, height: 170, mode: "gray" },
    { type: "done", reason: "complete", message: "", pages: 2 },
  ]);
  const page = await client.fetchPage(id, 1);
  expect(new TextDecoder().decode(page.subarray(0, 2))).toBe("P5");
  expect(page.length).toBe(new TextEncoder().encode("P5\n120 170\n255\n").length + 120 * 170);
  await client.deleteJob(id);
  expect(fake.deleted).toEqual([id]);
});

test("fetchPageToFile streams a page to disk, byte for byte (gzip decoded)", async () => {
  const { fake, client } = setup();
  fake.scenario = { pages: 1 };
  const id = await client.startScan({ source: "adf", mode: "gray", dpi: 75 });
  for await (const _ of client.jobEvents(id));
  const path = join(tmpdir(), "page.pnm");
  const size = await client.fetchPageToFile(id, 1, path);
  const bytes = readFileSync(path);
  expect(size).toBe(bytes.length);
  expect(bytes.equals(await client.fetchPage(id, 1))).toBe(true);
});

test("jobEvents throws ServiceUnreachable when the service dies mid-scan", async () => {
  const { fake, client } = setup();
  fake.scenario = { pages: 4, dieAfterPages: 2 };
  const id = await client.startScan({ source: "adf", mode: "gray", dpi: 75 });
  const pages: number[] = [];
  const err = await (async () => {
    for await (const e of client.jobEvents(id)) if (e.type === "page") pages.push(e.n);
  })().catch((e) => e);
  expect(err).toBeInstanceOf(ServiceUnreachable);
  expect(pages).toEqual([1, 2]);
});
