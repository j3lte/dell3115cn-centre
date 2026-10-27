import { afterEach, expect, test } from "bun:test";
import { COMMON_INPUT_PROFILES } from "../src/server/common-profiles";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { magickAvailable } from "../src/server/pipeline/magick";
import { FakeScannerService } from "./fake-service";
import { tmpdir } from "./helpers";

const procs: { kill(): void }[] = [];
const fakes: FakeScannerService[] = [];
afterEach(() => {
  while (procs.length) procs.pop()!.kill();
  while (fakes.length) fakes.pop()!.stop();
});

async function boot(env: Record<string, string>) {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/server/index.ts")], {
    env: { ...process.env, PORT: "0", LOG_LEVEL: "info", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  procs.push(proc);
  const reader = proc.stdout.getReader();
  let out = "";
  const deadline = Date.now() + 10000;
  while (!/listening on (http:\/\/\S+)/.test(out)) {
    if (Date.now() > deadline) throw new Error(`server did not start: ${out}`);
    const { value, done } = await reader.read();
    if (done) throw new Error(`server exited: ${out}${await new Response(proc.stderr).text()}`);
    out += new TextDecoder().decode(value);
  }
  return { base: out.match(/listening on (http:\/\/\S+)/)![1]!.replace(/\/$/, ""), out };
}

test("server boots, generates and shows a secret, serves the API and the live socket", async () => {
  const fake = new FakeScannerService().start();
  fakes.push(fake);
  const dataDir = tmpdir();
  const { base, out } = await boot({ SERVICE_URL: fake.url, DATA_DIR: dataDir, APP_SECRET: "" });
  const saved = readFileSync(join(dataDir, "app-secret"), "utf8").trim();
  expect(out).toContain(`APP_SECRET=${saved}`);
  expect(existsSync(join(dataDir, "scan-webapp.sqlite"))).toBe(true);

  const status = await fetch(`${base}/api/status`);
  expect(status.status).toBe(200);
  expect((await (await fetch(`${base}/api/input-profiles`)).json()).length).toBe(COMMON_INPUT_PROFILES.length);

  const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
  const first = await new Promise<any>((resolve, reject) => {
    ws.onmessage = (e) => resolve(JSON.parse(String(e.data)));
    ws.onerror = reject;
  });
  ws.close();
  expect(first.type).toBe("status");
});

test.skipIf(!magickAvailable())("a request that takes longer than Bun's idle timeout still gets its answer", async () => {
  const fake = new FakeScannerService().start();
  fakes.push(fake);
  fake.scenario = { pageDelayMs: 15_000 }; // Bun 1.4.4 cuts a quiet connection after 10-14 s
  const { base } = await boot({ SERVICE_URL: fake.url, DATA_DIR: tmpdir(), APP_SECRET: "set-by-user", PRINTER_URI: "off" });
  const r = await fetch(`${base}/api/preview`, { method: "POST" });
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toContain("image/png");
}, 40_000);

test("the live socket refuses a foreign Origin and accepts the app's own", async () => {
  const fake = new FakeScannerService().start();
  fakes.push(fake);
  const { base } = await boot({ SERVICE_URL: fake.url, DATA_DIR: tmpdir(), APP_SECRET: "set-by-user" });
  const open = (origin: string) =>
    new Promise<string>((resolve) => {
      const ws = new WebSocket(`${base.replace("http", "ws")}/ws`, { headers: { origin } } as any);
      ws.onmessage = () => {
        ws.close();
        resolve("message");
      };
      ws.onerror = () => resolve("error");
      ws.onclose = () => resolve("closed");
    });
  expect(await open("https://evil.example")).not.toBe("message");
  expect(await open(base)).toBe("message");
  const res = await fetch(`${base}/ws`, { headers: { origin: "https://evil.example", upgrade: "websocket", connection: "Upgrade" } });
  expect(res.status).toBe(403);
});

test("/api/status answers 200 even when the scanner service is unreachable", async () => {
  const { base, out } = await boot({ SERVICE_URL: "http://127.0.0.1:1", DATA_DIR: tmpdir(), APP_SECRET: "set-by-user" });
  expect(out).not.toContain("APP_SECRET=");
  const res = await fetch(`${base}/api/status`);
  expect(res.status).toBe(200);
  expect(["connecting", "unreachable"]).toContain((await res.json()).service);
});

test("serves the phone UI at /", async () => {
  const { base } = await boot({ SERVICE_URL: "http://127.0.0.1:1", DATA_DIR: tmpdir(), APP_SECRET: "set-by-user" });
  const res = await fetch(`${base}/`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  const html = await res.text();
  expect(html).toContain('<div id="root">');
  const script = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
  expect(script).toBeTruthy();
  const js = await fetch(new URL(script!, `${base}/`));
  expect(js.status).toBe(200);
});

test("/files/<id> is routed to the download handler (GET only)", async () => {
  const { base } = await boot({ SERVICE_URL: "http://127.0.0.1:1", DATA_DIR: tmpdir(), APP_SECRET: "set-by-user" });
  const link = `${base}/files/00000000-0000-4000-8000-000000000000?key=x`;
  expect((await fetch(link)).status).toBe(404);
  expect((await fetch(link, { method: "POST" })).status).toBe(405);
});

test("/mcp and /mcp/ are routed: MCP is on by default and wants the key", async () => {
  const { base, out } = await boot({ SERVICE_URL: "http://127.0.0.1:1", DATA_DIR: tmpdir(), APP_SECRET: "set-by-user" });
  expect(out).toContain("/mcp/ (enabled)");
  expect(out).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/);
  for (const path of ["/mcp", "/mcp/"]) expect((await fetch(`${base}${path}`, { method: "POST", body: "{}" })).status).toBe(401);
});

test("server tests run without a DOM", () => {
  expect(typeof window).toBe("undefined");
});
