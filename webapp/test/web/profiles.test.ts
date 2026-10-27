import { expect, test } from "bun:test";
import type { InputProfile, OutputProfile } from "../../src/web/types/api";
import { DESTINATION_TYPES, SECRET_FIELDS } from "../../src/server/destinations/types";
import { validateInput, validateOutput } from "../../src/server/profiles";
import { SMB_RETIRED } from "../../src/server/destinations/smb";
import { DEST_FIELDS, NEW_INPUT, NEW_OUTPUT, destLabel, destOptions, filenameExamples, inputSummary, outputSummary, withMode } from "../../src/web/helpers/profiles";

const filter = { preset: "none", threshold: 160, brightness: 0, contrast: 0, autoCrop: false, deskew: false } as const;
const profile = (over: Partial<InputProfile>): InputProfile =>
  ({ id: 1, name: "P", source: "flatbed", mode: "color", dpi: 600, paper: "glass", autoOrient: false, threshold: 128, filter, ...over }) as InputProfile;

test("inputSummary shows 16-bit", () => {
  expect(inputSummary(profile({ depth: 16 }))).toBe("Flatbed · Colour · 600 dpi · 16-bit");
  expect(inputSummary(profile({}))).toBe("Flatbed · Colour · 600 dpi");
});

test("withMode drops 16-bit when leaving colour", () => {
  expect(withMode(profile({ depth: 16 }), "gray")).toEqual({ mode: "gray", depth: undefined });
  expect(withMode(profile({ depth: 16 }), "color")).toEqual({ mode: "color", depth: 16 });
});

test("outputSummary shows the format and the destination", () => {
  const p = { id: 2, name: "Archive", format: "pdf_multi", jpegQuality: 85, filenameTemplate: "x", destination: { type: "sftp", config: {} } } as OutputProfile;
  expect(outputSummary(p)).toBe("One multi-page PDF → SFTP (SSH)");
});

test("retired destinations are offered only to a profile that still uses one, and say so", () => {
  const retired = { smb: SMB_RETIRED };
  expect(destOptions("download", retired).map(([t]) => t)).toEqual(["download", "folder", "sftp", "ftp", "paperless", "papra", "webhook"]);
  expect(destOptions("smb", retired).at(-1)).toEqual(["smb", "SMB share (no longer supported)"]);
  expect(destLabel("sftp", retired)).toBe("SFTP (SSH)");
});

test("filenameExamples shows the first two names, or the default name", () => {
  const date = new Date(2026, 9, 26, 9, 5);
  expect(filenameExamples("{profile}_{date}", "jpeg", "Archive Box", date)).toEqual(["archive-box_2026-10-26.jpg", "archive-box_2026-10-26-2.jpg"]);
  expect(filenameExamples("", "pdf_multi", "", date)).toEqual(["scan.pdf"]);
});

test("the form has fields for every destination the server knows, and masks the same secrets", () => {
  expect(Object.keys(DEST_FIELDS).sort()).toEqual([...DESTINATION_TYPES].sort());
  for (const type of DESTINATION_TYPES.filter((t) => t !== "smb")) {
    const secrets = DEST_FIELDS[type].filter((f) => f.kind === "secret").map((f) => f.key);
    expect([type, secrets.sort()]).toEqual([type, [...SECRET_FIELDS[type]].sort()]);
  }
});

test("a new profile passes the server's rules once it has a name", () => {
  expect(() => validateInput({ ...NEW_INPUT, name: "Letters" })).not.toThrow();
  expect(() => validateOutput({ ...NEW_OUTPUT, name: "Download" })).not.toThrow();
});
