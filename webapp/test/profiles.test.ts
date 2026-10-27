import { beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/server/db";
import { COMMON_INPUT_PROFILES, COMMON_OUTPUT_PROFILES } from "../src/server/common-profiles";
import { ValidationError, validateInput, validateOutput } from "../src/server/profiles";
import { ProfileRepo } from "../src/server/repos/profile-repo";
import { ProfileService } from "../src/server/services/profile-service";
import { SecretBox, SecretError } from "../src/server/secrets";
import { createDestinations } from "../src/server/destinations";
import { memoryHostKeys } from "./helpers";

let db: Database;
let repo: ProfileRepo;
let service: ProfileService;
const boxA = new SecretBox("secret-a");

beforeEach(() => {
  db = openDb(":memory:");
  repo = new ProfileRepo(db, boxA);
  service = new ProfileService(repo, createDestinations({ hostKeys: memoryHostKeys() }));
});

const paperless = (token: string) => ({
  name: "Archive",
  format: "pdf_multi" as const,
  jpegQuality: 80,
  filenameTemplate: "{date}_{time}_scan",
  destination: { type: "paperless" as const, config: { url: "http://paperless.example", token } },
});

test("seed present on empty DB: the common profiles", () => {
  const inputs = repo.listInput();
  expect(inputs.map((p) => p.name)).toEqual(COMMON_INPUT_PROFILES.map((p) => p.name));
  expect(inputs[0]).toMatchObject({ name: "Document (feeder, gray 300)", source: "adf", mode: "gray", dpi: 300, paper: "a4", autoOrient: true });
  expect(inputs[0]!.filter.preset).toBe("document");
  expect(inputs.find((p) => p.name === "Photo (flatbed, colour 300)")).toMatchObject({ source: "flatbed", mode: "color", dpi: 300, paper: "glass", autoOrient: false });
  expect(inputs.find((p) => p.name === "Receipt (flatbed, gray 300)")!.filter).toMatchObject({ autoCrop: true, deskew: true });
  expect(inputs.find((p) => p.name === "Text black & white (feeder, 300)")).toMatchObject({ mode: "lineart" });
  const outputs = repo.listOutput();
  expect(outputs.map((p) => p.name)).toEqual(COMMON_OUTPUT_PROFILES.map((p) => p.name));
  expect(outputs.map((p) => p.format)).toEqual(["pdf_multi", "pdf_single", "jpeg", "png", "tiff_multi"]);
  expect(outputs[0]).toMatchObject({ name: "Download PDF", filenameTemplate: "{date}_{time}_scan" });
  expect(outputs.every((p) => p.destination.type === "download")).toBe(true);
});

test("every common profile passes validation", () => {
  for (const p of COMMON_INPUT_PROFILES) expect(() => validateInput(p)).not.toThrow();
  for (const p of COMMON_OUTPUT_PROFILES) expect(() => validateOutput(p)).not.toThrow();
});

test("addCommon adds only missing names and leaves edited ones alone", () => {
  const doc = repo.listInput()[0]!;
  repo.saveInput({ ...doc, dpi: 600 });
  for (const p of repo.listInput().slice(1)) repo.deleteInput(p.id);
  repo.deleteOutput(repo.listOutput()[1]!.id);
  expect(repo.addCommon()).toEqual({ input: COMMON_INPUT_PROFILES.length - 1, output: 1 });
  expect(repo.listInput().find((p) => p.name === doc.name)!.dpi).toBe(600);
  expect(repo.addCommon()).toEqual({ input: 0, output: 0 });
});

test("seed only once: deleting all profiles does not re-seed on reopen", () => {
  for (const p of repo.listInput()) repo.deleteInput(p.id);
  expect(new ProfileRepo(db, boxA).listInput()).toHaveLength(0);
});

test("input profile roundtrip", () => {
  const saved = repo.saveInput({ name: "BW", source: "adf", mode: "lineart", dpi: 200, paper: "legal", autoOrient: false, threshold: 140 });
  expect(repo.getInput(saved.id)).toEqual(saved);
  const updated = repo.saveInput({ ...saved, dpi: 600 });
  expect(updated.id).toBe(saved.id);
  expect(repo.getInput(saved.id)!.dpi).toBe(600);
  repo.deleteInput(saved.id);
  expect(repo.getInput(saved.id)).toBeNull();
});

test("inputExists and outputExists answer without opening secrets", () => {
  const input = repo.saveInput({ name: "BW", source: "adf", mode: "lineart", dpi: 200, paper: "a4", autoOrient: false, threshold: 140 });
  const output = repo.saveOutput(paperless("tok"));
  const noOpen = new ProfileRepo(db, Object.assign(new SecretBox("secret-a"), { open: () => { throw new Error("opened a secret"); } }));
  expect(noOpen.inputExists(input.id)).toBe(true);
  expect(noOpen.outputExists(output.id)).toBe(true);
  expect(noOpen.inputExists(999)).toBe(false);
  expect(noOpen.outputExists(999)).toBe(false);
});

test("input profile keeps 16-bit depth; 8 bits is stored as no depth", () => {
  const deep = repo.saveInput({ name: "Photo 16", source: "flatbed", mode: "color", dpi: 600, paper: "glass", autoOrient: false, threshold: 128, depth: 16 });
  expect(repo.getInput(deep.id)!.depth).toBe(16);
  const back = repo.saveInput({ ...deep, depth: 8 });
  expect("depth" in repo.getInput(back.id)!).toBe(false);
  expect(() => service.updateInput(deep.id, { ...deep, mode: "gray" })).toThrow("colour only");
});

test("output profile roundtrip with secret decrypted for use, encrypted at rest", () => {
  const saved = repo.saveOutput(paperless("tok-123"));
  expect(repo.getOutputForUse(saved.id).destination.config.token).toBe("tok-123");
  const raw = db.query<{ destination_config: string }, [number]>("SELECT destination_config FROM output_profiles WHERE id = ?").get(saved.id)!;
  expect(raw.destination_config).not.toContain("tok-123");
  expect(JSON.parse(raw.destination_config).token.startsWith("enc:v1:")).toBe(true);
  repo.deleteOutput(saved.id);
  expect(repo.getOutput(saved.id)).toBeNull();
});

test("toPublic masks token", () => {
  const saved = repo.saveOutput(paperless("tok-123"));
  const pub = repo.toPublic(repo.getOutput(saved.id)!);
  expect(pub.destination.config.token).toBe("••••");
  expect(JSON.stringify(pub)).not.toContain("tok-123");
  const empty = repo.saveOutput(paperless(""));
  expect(repo.toPublic(repo.getOutput(empty.id)!).destination.config.token).toBe("");
});

test("saving with •••• keeps the old token", () => {
  const saved = repo.saveOutput(paperless("tok-123"));
  repo.saveOutput({ ...repo.toPublic(repo.getOutput(saved.id)!), name: "Renamed" });
  const used = repo.getOutputForUse(saved.id);
  expect(used.name).toBe("Renamed");
  expect(used.destination.config.token).toBe("tok-123");
});

test("test_secret_change_marks_needs_credentials", () => {
  const saved = repo.saveOutput(paperless("tok-123"));
  const repoB = new ProfileRepo(db, new SecretBox("secret-b"));
  const listed = repoB.listOutput().find((p) => p.id === saved.id)!;
  expect(listed.needsCredentials).toBe(true);
  expect(repoB.toPublic(listed).destination.config.token).toBe("••••");
  expect(() => repoB.getOutputForUse(saved.id)).toThrow(SecretError);
  expect(repo.listOutput().find((p) => p.id === saved.id)!.needsCredentials).toBeFalsy();
  // re-entering the credential with the new secret fixes it
  repoB.saveOutput({ ...listed, destination: { type: "paperless", config: { ...listed.destination.config, token: "tok-new" } } });
  expect(repoB.getOutputForUse(saved.id).destination.config.token).toBe("tok-new");
});

test("validation rejects bad input profiles", () => {
  const base = { name: "x", source: "adf" as const, mode: "gray" as const, dpi: 300 as const, paper: "a4" as const, autoOrient: true, threshold: 128 };
  expect(() => validateInput({ ...base, dpi: 123 as any })).toThrow(ValidationError);
  expect(() => validateInput({ ...base, source: "flatbed", paper: "a4" })).toThrow(ValidationError);
  expect(() => validateInput({ ...base, source: "adf", paper: "glass" })).toThrow(ValidationError);
  expect(() => validateInput({ ...base, mode: "sepia" as any })).toThrow(ValidationError);
  expect(() => validateInput({ ...base, threshold: 300 })).toThrow(ValidationError);
  expect(() => validateInput({ ...base, name: " " })).toThrow(ValidationError);
});

test("validation rejects bad output profiles", () => {
  expect(() => validateOutput({ ...paperless("t"), format: "gif" as any })).toThrow(ValidationError);
  expect(() => validateOutput({ ...paperless("t"), filenameTemplate: "  " })).toThrow(ValidationError);
  expect(() => validateOutput({ ...paperless("t"), destination: { type: "carrier-pigeon" as any, config: {} } })).toThrow(ValidationError);
  expect(() => validateOutput({ ...paperless("t"), jpegQuality: 0 })).toThrow(ValidationError);
});

test("TIFF output formats are accepted", () => {
  for (const format of ["tiff_single", "tiff_multi"] as const) {
    const saved = repo.saveOutput({ ...paperless("t"), format });
    expect(repo.getOutput(saved.id)!.format).toBe(format);
  }
});
