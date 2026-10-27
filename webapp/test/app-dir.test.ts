import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { buildBundle } from "../build";
import { appDir, bundled } from "../src/server/app-dir";
import { tmpdir } from "./helpers";

test("from source, appDir is the webapp folder", () => {
  expect(bundled).toBe(false);
  expect(existsSync(join(appDir, "package.json"))).toBe(true);
  expect(existsSync(join(appDir, "src", "server", "app-dir.ts"))).toBe(true);
});

/** A free TCP port on localhost. */
async function freePort(): Promise<number> {
  return new Promise((done) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => done(port));
    });
  });
}

describe("the production bundle", () => {
  // The image's layout: <app>/dist (the bundle) next to <app>/assets, started from another working directory.
  const app = tmpdir();
  const elsewhere = tmpdir();
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  let base: string;

  beforeAll(async () => {
    await buildBundle(join(app, "dist"));
    mkdirSync(join(app, "assets"));
    writeFileSync(join(app, "assets", "dell3115cn.icm"), "not a real profile");
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    proc = Bun.spawn(["bun", join(app, "dist", "start.js")], {
      cwd: elsewhere,
      env: { ...process.env, PORT: String(port), DATA_DIR: "data", SERVICE_URL: "http://127.0.0.1:9", PRINTER_URI: "off" },
      stdout: "pipe",
      stderr: "pipe",
    });
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${base}/api/status`).then((r) => r.ok, () => false)) return;
      await Bun.sleep(100);
    }
    throw new Error("the bundle did not start");
  }, 30_000);

  afterAll(() => proc?.kill());

  test("serves the UI and its bundled files, from any working directory", async () => {
    const html = await (await fetch(base)).text();
    const files = [...html.matchAll(/(?:src|href)="\.\/([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
    expect(files.length).toBeGreaterThan(1);
    for (const f of files) expect((await fetch(`${base}/${f}`)).status).toBe(200);
  });

  test("serves Scalar's bundle copied next to it", async () => {
    const r = await fetch(`${base}/api/docs/scalar.js`);
    expect(r.status).toBe(200);
    expect((await r.text()).length).toBeGreaterThan(100_000);
  });

  test("keeps a relative DATA_DIR relative to where it was started, and finds assets/ next to dist/", async () => {
    expect(existsSync(join(elsewhere, "data", "scan-webapp.sqlite"))).toBe(true);
    proc.kill();
    await proc.exited;
    const log = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    expect(log).not.toContain("Scanner colour profile not found");
  });
});
