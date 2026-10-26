import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Scalar } from "@scalar/hono-api-reference";
import type { Handler } from "hono";
import { fail } from "./errors";

/** Where the image keeps Scalar's bundle (`vendor/scalar.js` in the app folder; the Dockerfile copies it there). */
const vendoredBundle = fileURLToPath(new URL("../../../vendor/scalar.js", import.meta.url));

/**
 * Scalar's single-file browser bundle: the vendored copy, else the dev dependency's `dist/browser/standalone.js` (not an
 * exported path, so found next to the package entry `dist/index.js`). A production install has neither package nor copy
 * unless the image put the copy there.
 */
function findScalarBundle(): string | undefined {
  if (existsSync(vendoredBundle)) return vendoredBundle;
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
