// Production bundle (what the image runs): the server and its HTML-imported UI (React, Tailwind) in one flat dist/,
// plus Scalar's bundle in vendor/. assets/ stays where it is. Only sharp (a native addon) stays in node_modules.
// Run it from dist/ (`cd dist && bun index.js`): Bun looks up the UI's chunks relative to the working directory.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import tailwind from "bun-plugin-tailwind";

rmSync("dist", { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: ["src/server/index.ts"],
  outdir: "dist",
  naming: { entry: "[name].[ext]" }, // index.js, index.html and the chunks side by side
  target: "bun",
  plugins: [tailwind],
  external: ["sharp"],
  minify: true,
  define: { BUNDLED: "true", "process.env.NODE_ENV": '"production"' },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
mkdirSync("vendor", { recursive: true });
cpSync("node_modules/@scalar/api-reference/dist/browser/standalone.js", "vendor/scalar.js");
