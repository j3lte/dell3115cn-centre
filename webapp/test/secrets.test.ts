import { expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/server/config";
import { resolveAppSecret, SecretBox, SecretError } from "../src/server/secrets";
import { tmpdir } from "./helpers";

test("seal/open roundtrip and tamper detection", () => {
  const box = new SecretBox("s3cret");
  const sealed = box.seal("hunter2");
  expect(sealed.startsWith("enc:v1:")).toBe(true);
  expect(box.open(sealed)).toBe("hunter2");
  expect(() => new SecretBox("other").open(sealed)).toThrow(SecretError);
});

test("same plaintext seals differently (random IV)", () => {
  const box = new SecretBox("s3cret");
  expect(box.seal("a")).not.toBe(box.seal("a"));
});

test("garbage input throws SecretError", () => {
  expect(() => new SecretBox("s3cret").open("enc:v1:AAAA")).toThrow(SecretError);
  expect(() => new SecretBox("s3cret").open("plain")).toThrow(SecretError);
});

test("generated secret persisted and reused", () => {
  const d = tmpdir();
  const a = resolveAppSecret(loadConfig({}), d);
  const b = resolveAppSecret(loadConfig({}), d);
  expect(a.generated).toBe(true);
  expect(b.secret).toBe(a.secret);
  expect(a.secret.length).toBeGreaterThanOrEqual(43);
  expect(statSync(join(d, "app-secret")).mode & 0o777).toBe(0o600);
  expect(resolveAppSecret(loadConfig({ APP_SECRET: "x" }), d)).toEqual({ secret: "x", generated: false });
});
