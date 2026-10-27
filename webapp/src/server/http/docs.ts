import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Scalar } from "@scalar/hono-api-reference";
import type { Handler } from "hono";
import { bundled } from "../app-dir";
import { fail } from "./errors";

/** Scalar's bundle as build.ts copies it next to the production bundle. */
const vendoredBundle = bundled ? join(import.meta.dir, "scalar.js") : undefined;

/**
 * Scalar's single-file browser bundle: build.ts's copy, else (running from source) the dev dependency's
 * `dist/browser/standalone.js` (not an exported path, so found next to the package entry `dist/index.js`).
 */
function findScalarBundle(): string | undefined {
  if (vendoredBundle && existsSync(vendoredBundle)) return vendoredBundle;
  try {
    const dev = fileURLToPath(new URL("browser/standalone.js", import.meta.resolve("@scalar/api-reference")));
    return existsSync(dev) ? dev : undefined;
  } catch {
    return undefined;
  }
}

/** The API reference page; it loads its script from this app, so it works without internet. */
export const docsPage = Scalar({ url: "/api/openapi.json", cdn: "/api/docs/scalar.js", pageTitle: "Dell 3115cn Centre API", withDefaultFonts: false });

export const scalarScript: Handler = () => {
  const bundle = findScalarBundle();
  if (!bundle) return fail(404, "not_found", "API reference script not installed");
  return new Response(Bun.file(bundle), {
    headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400" },
  });
};
