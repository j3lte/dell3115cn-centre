// Production bundle (what the image runs): `bun build.ts` writes dist/ with the server and its HTML-imported UI
// (React, Tailwind), source maps and Scalar's bundle side by side; run it with `bun dist/start.js` from anywhere.
// assets/ stays in the webapp folder next to dist/. Only sharp (a native addon) stays in node_modules.
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import tailwind from "bun-plugin-tailwind";

export async function buildBundle(outdir = "dist"): Promise<void> {
  rmSync(outdir, { recursive: true, force: true });
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "src/server/start.ts")],
    outdir,
    naming: { entry: "[name].[ext]" }, // start.js, index.html and the chunks side by side
    target: "bun",
    plugins: [tailwind],
    external: ["sharp"],
    minify: true,
    sourcemap: "linked",
    define: { BUNDLED: "true", "process.env.NODE_ENV": '"production"' },
  });
  if (!result.success) throw new AggregateError(result.logs, "bundle failed");
  cpSync(join(import.meta.dir, "node_modules/@scalar/api-reference/dist/browser/standalone.js"), join(outdir, "scalar.js"));
}

if (import.meta.main) await buildBundle();
