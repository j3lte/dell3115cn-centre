import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { appDir } from "../src/server/app-dir";

describe("appDir", () => {
  test("is the webapp folder when running from source", () => {
    expect(existsSync(join(appDir({}), "package.json"))).toBe(true);
    expect(existsSync(join(appDir({}), "src", "server", "app-dir.ts"))).toBe(true);
  });

  test("APP_DIR overrides it (the bundled image sets /app)", () => {
    expect(appDir({ APP_DIR: "/app" })).toBe("/app");
  });
});
