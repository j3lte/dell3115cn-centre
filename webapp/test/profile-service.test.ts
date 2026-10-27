import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { sftp } from "../src/server/destinations/sftp";
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

// ---- retired SMB and SFTP's trusted host key

const SMB_RETIRED = "SMB is no longer supported; choose another destination";
const HOST_KEY = `SHA256:${"k".repeat(43)}`;

function withSmbRow(): { service: ProfileService; id: number } {
  const db = openDb(":memory:");
  const box = new SecretBox("secret-a");
  const config = JSON.stringify({ server: "nas.example", share: "scans", path: "", username: "u", password: box.seal("pw") });
  const id = db
    .query<{ id: number }, [string]>(
      "INSERT INTO output_profiles (name, format, jpeg_quality, filename_template, destination_type, destination_config) VALUES ('Old NAS', 'pdf_multi', 80, '{date}', 'smb', ?) RETURNING id",
    )
    .get(config)!.id;
  return { service: new ProfileService(new ProfileRepo(db, box)), id };
}

test("an SMB profile from an older version still loads (secret masked) but refuses to be used or saved", async () => {
  const { service: s, id } = withSmbRow();
  const p = s.getOutput(id);
  expect(p.destination).toEqual({ type: "smb", config: { server: "nas.example", share: "scans", path: "", username: "u", password: "••••" } });
  expect(s.listOutput().some((x) => x.id === id && x.destination.type === "smb")).toBe(true);
  await expect(s.testOutput(id)).rejects.toThrow(SMB_RETIRED);
  await expect(s.testDestination("smb", p.destination.config, id, "targets")).rejects.toThrow(SMB_RETIRED);
  expect(() => s.saveOutput({ ...p }, "targets")).toThrow(SMB_RETIRED);
  // Switching it to another destination works.
  const switched = s.saveOutput({ ...p, destination: { type: "folder", config: { path: "/export" } } }, "targets");
  expect(switched.destination.type).toBe("folder");
});

const sftpProfile = (config: Record<string, unknown> = {}) => ({
  name: "Server",
  format: "pdf_multi" as const,
  jpegQuality: 80,
  filenameTemplate: "{date}_scan",
  destination: { type: "sftp" as const, config: { host: "files.example", port: 22, path: "scans", username: "u", password: "pw", ...config } },
});

describe("sftp host key (trust on first use)", () => {
  afterEach(() => mock.restore());

  test("a saved profile's first Test stores the host key; secrets survive", async () => {
    spyOn(sftp, "test").mockResolvedValue({ hostKey: HOST_KEY });
    const saved = service.saveOutput(sftpProfile(), "targets");
    expect(await service.testOutput(saved.id)).toEqual({ hostKey: HOST_KEY });
    expect(service.getOutput(saved.id).destination.config).toMatchObject({ hostKey: HOST_KEY, password: "••••" });
    expect(service.getOutputForUse(saved.id).destination.config.password).toBe("pw");
  });

  test("Test of an unsaved form returns the key; it is stored only for the same profile and host", async () => {
    spyOn(sftp, "test").mockResolvedValue({ hostKey: HOST_KEY });
    expect(await service.testDestination("sftp", sftpProfile().destination.config, undefined, "targets")).toEqual({ hostKey: HOST_KEY });
    const saved = service.saveOutput(sftpProfile(), "targets");
    const elsewhere = { ...saved.destination.config, host: "other.example", password: "pw2" };
    expect(await service.testDestination("sftp", elsewhere, saved.id, "targets")).toEqual({ hostKey: HOST_KEY });
    expect(service.getOutput(saved.id).destination.config.hostKey).toBeUndefined();
    await service.testDestination("sftp", saved.destination.config, saved.id, "targets");
    expect(service.getOutput(saved.id).destination.config.hostKey).toBe(HOST_KEY);
  });

  test("learn() never replaces a stored key and ignores a profile that changed type", () => {
    const saved = service.saveOutput(sftpProfile({ hostKey: HOST_KEY }), "targets");
    service.learn(saved.id, "sftp", saved.destination.config, { hostKey: `SHA256:${"x".repeat(43)}` });
    expect(service.getOutput(saved.id).destination.config.hostKey).toBe(HOST_KEY);
    service.learn(saved.id, "ftp", saved.destination.config, { hostKey: "x" });
    expect(service.getOutput(saved.id).destination.type).toBe("sftp");
  });

  test("a forgotten host key (null) is saved as empty, so the next Test trusts again", async () => {
    const saved = service.saveOutput(sftpProfile({ hostKey: HOST_KEY }), "targets");
    const cleared = service.saveOutput({ ...saved, destination: { ...saved.destination, config: { ...saved.destination.config, hostKey: null } } }, "targets");
    expect(cleared.destination.config.hostKey).toBe("");
    spyOn(sftp, "test").mockResolvedValue({ hostKey: HOST_KEY });
    await service.testOutput(saved.id);
    expect(service.getOutput(saved.id).destination.config.hostKey).toBe(HOST_KEY);
  });
});

describe("sftp host key is server-managed", () => {
  afterEach(() => mock.restore());
  const stored = () => service.saveOutput(sftpProfile({ hostKey: HOST_KEY }), "targets");
  const withKey = (p: ReturnType<typeof stored>, hostKey: unknown, over: Record<string, unknown> = {}) => ({
    ...p,
    destination: { type: "sftp" as const, config: { ...p.destination.config, hostKey, ...over } },
  });

  test("an assistant can forget it with null without re-entering the masked secrets", () => {
    const p = stored();
    expect(p.destination.config.password).toBe("••••");
    service.saveOutput(withKey(p, null), "all");
    expect(service.getOutput(p.id).destination.config.hostKey).toBe("");
    expect(service.getOutputForUse(p.id).destination.config.password).toBe("pw");
  });

  test("an empty value from an assistant keeps it too", () => {
    const p = stored();
    service.saveOutput(withKey(p, ""), "all");
    expect(service.getOutput(p.id).destination.config.hostKey).toBe(HOST_KEY);
  });

  test("another host or port doesn't inherit it; a pinned key can be set explicitly", () => {
    const p = stored();
    service.saveOutput(withKey(p, "", { host: "other.example", password: "pw2" }), "targets");
    expect(service.getOutput(p.id).destination.config.hostKey).toBe("");
    const other = `SHA256:${"o".repeat(43)}`;
    service.saveOutput(withKey(service.getOutput(p.id), other), "targets");
    expect(service.getOutput(p.id).destination.config.hostKey).toBe(other);
  });
});
