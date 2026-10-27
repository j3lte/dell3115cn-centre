import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { isUuid, openDb } from "../src/server/db";
import { ValidationError } from "../src/server/destinations/types";
import { SettingsRepo } from "../src/server/repos/settings-repo";
import { NotFound } from "../src/server/services/errors";
import { SettingsService } from "../src/server/services/settings-service";
import { tmpdir } from "./helpers";

const cal = { gains: [1, 1.1, 1.2] as [number, number, number], white: [200, 210, 220] as [number, number, number], at: 1 };

let db: ReturnType<typeof openDb>;
afterEach(() => db?.close());

function make(opts: { secret?: { secret: string; generated: boolean }; inputs?: number[]; outputs?: number[] } = {}) {
  db = openDb(join(tmpdir(), "db.sqlite"));
  const repo = new SettingsRepo(db);
  let changes = 0;
  const { inputs = [], outputs = [] } = opts;
  const service = new SettingsService(
    repo,
    { inputExists: (id) => inputs.includes(id), outputExists: (id) => outputs.includes(id) },
    opts.secret ?? { secret: "s", generated: false },
    () => changes++,
  );
  return { repo, service, changes: () => changes };
}

test("read() on an empty database returns the defaults", () => {
  const { service } = make();
  expect(service.read()).toEqual({
    cleanupDays: null,
    buttonInputProfileId: null,
    buttonOutputProfileIds: {},
    mcpEnabled: true,
    mcpKey: null,
    mcpShelfLifeMinutes: 60,
    whiteBalance: {},
    printerWakeHours: 24,
  });
});

test("ensureMcpKey generates a UUID once, enabled, and keeps what is stored", () => {
  const { service, repo } = make();
  const a = service.ensureMcpKey();
  expect(isUuid(a.mcpKey)).toBe(true);
  expect(a.mcpEnabled).toBe(true);
  expect(a.mcpShelfLifeMinutes).toBe(60);
  repo.write({ mcpEnabled: false });
  expect(service.ensureMcpKey()).toMatchObject({ mcpKey: a.mcpKey, mcpEnabled: false });
});

test("regenerateMcpKey changes the key and fires onMcpChange", () => {
  const { service, changes } = make();
  const a = service.ensureMcpKey();
  const b = service.regenerateMcpKey();
  expect(isUuid(b.mcpKey)).toBe(true);
  expect(b.mcpKey).not.toBe(a.mcpKey);
  expect(changes()).toBe(1);
});

test("update rejects cleanupDays 0", () => {
  const { service } = make();
  expect(() => service.update({ cleanupDays: 0 }, { allowMcp: false })).toThrow(ValidationError);
  expect(service.update({ cleanupDays: "14" }, { allowMcp: false }).cleanupDays).toBe(14);
  expect(service.update({ cleanupDays: null }, { allowMcp: false }).cleanupDays).toBeNull();
});

test("update validates printerWakeHours: whole hours 1-720, or null for never", () => {
  const { service } = make();
  for (const bad of [0, 721]) expect(() => service.update({ printerWakeHours: bad }, { allowMcp: false })).toThrow("printerWakeHours must be 1-720 hours");
  for (const bad of [1.5, "x", true]) expect(() => service.update({ printerWakeHours: bad }, { allowMcp: false })).toThrow("printerWakeHours must be an integer");
  expect(service.update({ printerWakeHours: "6" }, { allowMcp: false }).printerWakeHours).toBe(6);
  expect(service.update({ printerWakeHours: 720 }, { allowMcp: false }).printerWakeHours).toBe(720);
  expect(service.update({ printerWakeHours: null }, { allowMcp: false }).printerWakeHours).toBeNull();
});

test("a stored null reads as the default, except for printerWakeHours where it means never", () => {
  const { repo } = make();
  db.run("INSERT INTO settings (key, value) VALUES ('whiteBalance', 'null'), ('mcpShelfLifeMinutes', 'null'), ('printerWakeHours', 'null')");
  expect(repo.read()).toMatchObject({ whiteBalance: {}, mcpShelfLifeMinutes: 60, printerWakeHours: null });
});

test("update checks that button profiles exist and merges per panel format", () => {
  const { service } = make({ inputs: [1, 3], outputs: [1, 2] });
  expect(() => service.update({ buttonInputProfileId: 9 }, { allowMcp: false })).toThrow(NotFound);
  expect(() => service.update({ buttonInputProfileId: 2 }, { allowMcp: false })).toThrow("Input profile not found");
  expect(() => service.update({ buttonOutputProfileIds: { pdf: 9 } }, { allowMcp: false })).toThrow("Output profile not found");
  expect(() => service.update({ buttonOutputProfileIds: { pdf: 3 } }, { allowMcp: false })).toThrow("Output profile not found");
  expect(() => service.update({ buttonOutputProfileIds: { gif: 1 } }, { allowMcp: false })).toThrow(ValidationError);
  service.update({ buttonInputProfileId: 1, buttonOutputProfileIds: { pdf: 1 } }, { allowMcp: false });
  const s = service.update({ buttonOutputProfileIds: { tiff: 2, pdf: null } }, { allowMcp: false });
  expect(s).toMatchObject({ buttonInputProfileId: 1, buttonOutputProfileIds: { tiff: 2 } });
});

test("update ignores mcpEnabled and shelf life without allowMcp", () => {
  const { service } = make();
  const s = service.update({ mcpEnabled: false, mcpShelfLifeMinutes: 5 }, { allowMcp: false });
  expect(s).toMatchObject({ mcpEnabled: true, mcpShelfLifeMinutes: 60 });
});

test("update validates the MCP fields with allowMcp", () => {
  const { service } = make();
  expect(() => service.update({ mcpEnabled: "yes" }, { allowMcp: true })).toThrow(ValidationError);
  expect(() => service.update({ mcpShelfLifeMinutes: 4 }, { allowMcp: true })).toThrow("mcpShelfLifeMinutes must be 5-1440");
  expect(service.update({ mcpShelfLifeMinutes: 1440 }, { allowMcp: true }).mcpShelfLifeMinutes).toBe(1440);
});

test("onMcpChange fires once when mcpEnabled flips, not when it is unchanged", () => {
  const { service, changes } = make();
  service.update({ mcpEnabled: true }, { allowMcp: true });
  service.update({ cleanupDays: 3 }, { allowMcp: true });
  expect(changes()).toBe(0);
  service.update({ mcpEnabled: false }, { allowMcp: true });
  expect(changes()).toBe(1);
  service.update({ mcpEnabled: false }, { allowMcp: true });
  expect(changes()).toBe(1);
});

test("setWhiteBalance(source, null) removes only that source", () => {
  const { service } = make();
  service.setWhiteBalance("flatbed", cal);
  service.setWhiteBalance("adf", cal);
  expect(service.read().whiteBalance).toEqual({ flatbed: cal, adf: cal });
  service.setWhiteBalance("adf", null);
  expect(service.read().whiteBalance).toEqual({ flatbed: cal });
});

test("view() includes generatedSecret only when the secret was generated", () => {
  expect(make({ secret: { secret: "gen", generated: true } }).service.view()).toMatchObject({ secretGenerated: true, generatedSecret: "gen" });
  const plain = make({ secret: { secret: "set", generated: false } }).service.view();
  expect(plain.secretGenerated).toBe(false);
  expect(plain).not.toHaveProperty("generatedSecret");
});
