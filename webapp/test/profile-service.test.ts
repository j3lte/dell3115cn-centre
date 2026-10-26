import { beforeEach, expect, test } from "bun:test";
import { openDb } from "../src/server/db";
import { ProfileRepo } from "../src/server/repos/profile-repo";
import { ValidationError } from "../src/server/profiles";
import { NotFound } from "../src/server/services/errors";
import { SecretBox } from "../src/server/secrets";
import { ProfileService } from "../src/server/services/profile-service";

let service: ProfileService;

beforeEach(() => {
  service = new ProfileService(new ProfileRepo(openDb(":memory:"), new SecretBox("secret-a")));
});

const input = { name: "BW", source: "adf" as const, mode: "lineart" as const, dpi: 200 as const, paper: "legal" as const, autoOrient: false, threshold: 140 };

const paperless = (over: { url?: string; tags?: number[]; token?: string } = {}) => ({
  name: "Archive",
  format: "pdf_multi" as const,
  jpegQuality: 80,
  filenameTemplate: "{date}_{time}_scan",
  destination: { type: "paperless" as const, config: { url: "http://paperless.example", token: "super-secret-token", tags: [1], ...over } },
});

test("createInput ignores a given id", () => {
  const first = service.createInput(input);
  const second = service.createInput({ ...input, id: first.id });
  expect(second.id).not.toBe(first.id);
  expect(service.listInput().filter((p) => p.name === "BW")).toHaveLength(2);
});

test("updateInput on a missing id throws NotFound", () => {
  expect(() => service.updateInput(99999, input)).toThrow(NotFound);
});

// The rules themselves are tested in profiles.test.ts; here only that create, update and save apply them.
test("input validation runs in the service", () => {
  expect(() => service.createInput({ ...input, dpi: 123 as any })).toThrow(ValidationError);
  const saved = service.createInput(input);
  expect(() => service.updateInput(saved.id, { ...input, threshold: 300 })).toThrow(ValidationError);
});

test("listOutput never contains a stored secret", () => {
  service.saveOutput(paperless(), "targets");
  const list = service.listOutput();
  expect(JSON.stringify(list)).not.toContain("super-secret-token");
  expect(JSON.stringify(list)).toContain("••••");
});

test('saveOutput with scope "targets" keeps the secret when only the tags change', () => {
  const saved = service.saveOutput(paperless(), "targets");
  service.saveOutput({ ...saved, destination: { ...saved.destination, config: { ...saved.destination.config, tags: [2] } } }, "targets");
  const used = service.getOutputForUse(saved.id);
  expect(used.destination.config.token).toBe("super-secret-token");
  expect(used.destination.config.tags).toEqual([2]);
});

test('saveOutput with scope "targets" refuses a masked secret when the host changes', () => {
  const saved = service.saveOutput(paperless(), "targets");
  const moved = { ...saved, destination: { ...saved.destination, config: { ...saved.destination.config, url: "http://evil.example" } } };
  expect(() => service.saveOutput(moved, "targets")).toThrow("enter the");
  expect(() => service.saveOutput(moved, "targets")).toThrow(ValidationError);
});

test('saveOutput with scope "all" refuses a masked secret when the tags change', () => {
  const saved = service.saveOutput(paperless(), "all");
  const moved = { ...saved, destination: { ...saved.destination, config: { ...saved.destination.config, tags: [2] } } };
  expect(() => service.saveOutput(moved, "all")).toThrow("enter the");
});

test("saveOutput on an unknown id throws NotFound; needsCredentials is dropped", () => {
  expect(() => service.saveOutput({ ...paperless(), id: 99999 }, "all")).toThrow(NotFound);
  const saved = service.saveOutput({ ...paperless(), needsCredentials: true }, "all");
  expect(saved.needsCredentials).toBeUndefined();
});

test("output validation runs in the service", () => {
  expect(() => service.saveOutput({ ...paperless(), format: "gif" as any }, "all")).toThrow(ValidationError);
});

test("testDestination with an unknown type throws ValidationError", async () => {
  await expect(service.testDestination("carrier-pigeon", {}, undefined, "all")).rejects.toThrow(ValidationError);
  await expect(service.testDestination("carrier-pigeon", {}, undefined, "all")).rejects.toThrow("Unknown destination: carrier-pigeon");
});

test("getOutput on an unknown id throws NotFound", () => {
  expect(() => service.getOutput(99999)).toThrow(NotFound);
  expect(service.findOutput(99999)).toBeNull();
});

test("addCommon twice adds nothing the second time", () => {
  for (const p of service.listInput()) service.deleteInput(p.id);
  for (const p of service.listOutput()) service.deleteOutput(p.id);
  const first = service.addCommon();
  expect(first.input).toBeGreaterThan(0);
  expect(first.output).toBeGreaterThan(0);
  expect(service.addCommon()).toEqual({ input: 0, output: 0 });
});

test("testOutput and getOutputForUse on a missing id reject with ValidationError", async () => {
  await expect(service.testOutput(99999)).rejects.toThrow(ValidationError);
  expect(() => service.getOutputForUse(99999)).toThrow("Output profile 99999 not found");
});
