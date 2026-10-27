import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { appDir, bundled } from "../src/server/app-dir";

test("from source, appDir is the webapp folder", () => {
  expect(bundled).toBe(false);
  expect(existsSync(join(appDir(), "package.json"))).toBe(true);
  expect(existsSync(join(appDir(), "src", "server", "app-dir.ts"))).toBe(true);
});
