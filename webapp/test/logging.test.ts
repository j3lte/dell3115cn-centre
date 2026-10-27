import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/server/http/app";
import type { PrinterSource } from "../src/server/printer";
import { PRINTER_OFF } from "../src/server/printer";
import { DEFAULT_FILTER } from "../src/server/pipeline/filters";
import { magickAvailable } from "../src/server/pipeline/magick";
import { adhocProfile } from "../src/server/services/scan-service";
import { loggedHostKeys } from "../src/server/destinations/sftp";
import { captureLog, fakeFingerprint, memoryHostKeys } from "./helpers";
import { makeHarness, type Harness } from "./scan-harness";

let h: Harness;
afterEach(() => h?.close());

describe("info", () => {
  const lines = captureLog();
  const of = (component: string) => lines.filter((l) => l.slice(6).startsWith(`${component}:`));

  test("a scan: started with its settings, pages scanned, delivered with file count", async () => {
    h = await makeHarness();
    h.fake.scenario = { pages: 3 };
    const v = await h.svc.start(h.input().id, h.folderOutput().id, { review: false });
    await h.svc.settled(v.id);
    expect(of("scan")).toEqual([
      `INFO  scan: ${v.id} started (ui): Feeder gray, adf gray 150 dpi`,
      `INFO  scan: ${v.id} scanned 3 page(s), delivering`,
      expect.stringMatching(new RegExp(`^INFO  scan: ${v.id} delivered to "To folder" \\(folder\\): 1 file\\(s\\) in \\d+\\.\\ds$`)),
    ]);
  });

  test("a scan without pages and a failed delivery are warnings", async () => {
    h = await makeHarness();
    h.fake.scenario = { pages: 0 };
    const empty = await h.svc.start(h.input().id, h.folderOutput().id, { review: false });
    await h.svc.settled(empty.id);
    expect(of("scan").at(-1)).toBe(`WARN  scan: ${empty.id} failed: No paper in the feeder`);

    h.fake.scenario = { pages: 1 };
    const bad = h.folderOutput({ name: "Nowhere", destination: { type: "folder", config: { path: "/nonexistent/x" } } });
    const v = await h.svc.start(h.input().id, bad.id, { review: false });
    await h.svc.settled(v.id);
    expect(of("scan").at(-1)).toStartWith(`WARN  scan: ${v.id} delivery to "Nowhere" (folder) failed: `);
  });

  test("cancel and delete", async () => {
    h = await makeHarness();
    const v = await h.svc.start(h.input().id, h.folderOutput().id, { review: true });
    await h.svc.settled(v.id);
    await h.svc.cancel(v.id);
    await h.svc.remove(v.id);
    expect(of("scan").slice(-2)).toEqual([`INFO  scan: ${v.id} cancelled`, `INFO  scan: ${v.id} deleted`]);
  });

  test("review tray edits: one line each", async () => {
    h = await makeHarness();
    h.fake.scenario = { pages: 3 };
    const v = await h.svc.start(h.input().id, h.folderOutput().id, { review: true });
    await h.svc.settled(v.id);
    await h.svc.rotate(v.id, 1, 90);
    await h.svc.reorder(v.id, [3, 1, 2]);
    await h.svc.removePage(v.id, 2);
    await h.svc.setScanFilter(v.id, { ...DEFAULT_FILTER, brightness: 10 });
    await h.svc.setPageFilter(v.id, 1, { ...DEFAULT_FILTER, contrast: 10 });
    await h.svc.setPageFilter(v.id, 1, null);
    await h.svc.more(v.id);
    await h.svc.settled(v.id);
    expect(of("scan").slice(2, 10)).toEqual([
      `INFO  scan: ${v.id} page 1 rotated 90°`,
      `INFO  scan: ${v.id} pages reordered: 3, 1, 2`,
      `INFO  scan: ${v.id} page 2 removed`,
      `INFO  scan: ${v.id} filter changed`,
      `INFO  scan: ${v.id} page 1 filter changed`,
      `INFO  scan: ${v.id} page 1 filter reset`,
      `INFO  scan: ${v.id} scanning more pages`,
      `INFO  scan: ${v.id} scanned 3 page(s), review`,
    ]);
  });

  test("printer button: the press, and why nothing started", async () => {
    h = await makeHarness();
    await h.svc.fromButton({ button: 1, target: "application", format: "pdf" });
    expect(of("scan")).toEqual(["INFO  scan: printer button pressed (pdf)", "WARN  scan: printer button: no default profiles are set"]);
  });

  test.skipIf(!magickAvailable())("preview: started and done", async () => {
    h = await makeHarness();
    await h.svc.preview();
    expect(of("scan")[0]).toBe("INFO  scan: preview started");
    expect(of("scan")[1]).toMatch(/^INFO  scan: preview done in \d+\.\ds$/);
  });

  test("destination tests: OK, or the reason they failed", async () => {
    h = await makeHarness();
    const ok = h.folderOutput();
    await h.profiles.testOutput(ok.id);
    await h.profiles.testDestination("folder", { path: "/nonexistent/x" }, undefined, "targets").catch(() => {});
    expect(of("profiles")).toEqual([
      `INFO  profiles: test of output profile ${ok.id} "To folder" (folder): OK`,
      expect.stringMatching(/^WARN  profiles: test of a folder destination failed: /),
    ]);
  });

  test("common profiles: how many were added", async () => {
    h = await makeHarness();
    h.profiles.addCommon(); // a fresh database has them all: no line
    h.profiles.deleteInput(h.profiles.listInput()[0]!.id);
    h.profiles.addCommon();
    expect(of("profiles").filter((l) => l.includes("common"))).toEqual(["INFO  profiles: added common profiles: 1 input, 0 output"]);
  });

  test("SFTP host keys: trusted on first use and forgotten, once each", async () => {
    const keys = loggedHostKeys(memoryHostKeys());
    keys.set("Host.example", 22, fakeFingerprint("a"));
    keys.set("Host.example", 22, fakeFingerprint("b")); // already trusted: no line
    keys.forget("host.example", 22);
    keys.forget("host.example", 22); // gone already: no line
    expect(of("sftp")).toEqual([`INFO  sftp: trusted the host key of Host.example:22 on first use: ${fakeFingerprint("a")}`, "INFO  sftp: forgot the host key of host.example:22"]);
  });

  test("a temporary scan's removal is not logged", async () => {
    h = await makeHarness();
    h.fake.scenario = { pages: 1 };
    const v = await h.svc.startAdhoc(adhocProfile({ source: "flatbed", mode: "gray", dpi: 150 }), { store: false });
    await h.svc.settled(v.id);
    await h.svc.remove(v.id);
    expect(of("scan").filter((l) => l.includes("deleted"))).toEqual([]);
  });

  test("settings: the changed keys, never their values; a new MCP key without the key", async () => {
    h = await makeHarness();
    h.settings.update({ cleanupDays: 30, printerWakeHours: 12 }, { allowMcp: true });
    h.settings.update({ cleanupDays: 30 }, { allowMcp: true }); // unchanged: no line
    const key = h.settings.regenerateMcpKey().mcpKey;
    expect(of("settings")).toEqual(["INFO  settings: changed cleanupDays, printerWakeHours", "INFO  settings: MCP key regenerated"]);
    expect(lines.join("\n")).not.toContain(key);
  });

  test("profiles: created, updated and deleted, by kind, id and name", async () => {
    h = await makeHarness();
    const i = h.profiles.createInput({ name: "Glass", source: "flatbed", mode: "color", dpi: 300, paper: "glass", autoOrient: false, threshold: 128 });
    h.profiles.updateInput(i.id, { name: "Glass 2", source: "flatbed", mode: "color", dpi: 300, paper: "glass", autoOrient: false, threshold: 128 });
    h.profiles.deleteInput(i.id);
    const o = h.profiles.saveOutput(
      { name: "Out", format: "png", jpegQuality: 80, filenameTemplate: "x", destination: { type: "folder", config: { path: h.outDir } } },
      "targets",
    );
    h.profiles.deleteOutput(o.id);
    h.profiles.deleteOutput(999); // nothing there: no line
    expect(of("profiles")).toEqual([
      `INFO  profiles: input profile ${i.id} "Glass" created`,
      `INFO  profiles: input profile ${i.id} "Glass 2" updated`,
      `INFO  profiles: input profile ${i.id} deleted`,
      `INFO  profiles: output profile ${o.id} "Out" created`,
      `INFO  profiles: output profile ${o.id} deleted`,
    ]);
  });

  test("scanner service: connected and unreachable, once per change", async () => {
    h = await makeHarness();
    expect(of("scanner")[0]).toMatch(/^INFO  scanner: service connected, printer \w+$/);
    h.fake.stop();
    const deadline = Date.now() + 2000;
    while (h.client.status.service !== "unreachable" && Date.now() < deadline) await Bun.sleep(5);
    await Bun.sleep(200); // a few reconnect attempts
    expect(of("scanner").filter((l) => l.includes("unreachable"))).toHaveLength(1);
    expect(of("scanner").at(-1)).toStartWith("WARN  scanner: service unreachable: ");
  });

  test("printer: a refresh says it wakes the printer", async () => {
    const source: PrinterSource = { get: async () => ({ ...PRINTER_OFF }), refresh: async () => ({ ...PRINTER_OFF }) };
    h = await makeHarness({ printer: source });
    await h.services.printer.refresh();
    expect(of("printer")).toEqual(["INFO  printer: reading supply levels (wakes the printer)"]);
  });
});

describe("debug", () => {
  const lines = captureLog("debug");

  test("API requests: method, path, status, time", async () => {
    h = await makeHarness();
    const app = createApp(h.services);
    await app.request("/api/settings");
    await app.request("/api/nope");
    const http = lines.filter((l) => l.startsWith("DEBUG http:"));
    expect(http[0]).toMatch(/^DEBUG http: GET \/api\/settings 200 \d+ms$/);
    expect(http[1]).toMatch(/^DEBUG http: GET \/api\/nope 404 \d+ms$/);
  });
});
