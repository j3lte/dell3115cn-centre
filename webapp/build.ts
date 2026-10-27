// Production bundle: the server plus its HTML-imported UI (React, Tailwind) in dist/, so the image needs no
// node_modules except sharp (a native addon with its own libvips, loaded from node_modules at run time).
// Run it from dist/ (`cd dist && bun index.js`): Bun looks up the UI's chunks relative to the working directory.
import tailwind from "bun-plugin-tailwind";

const result = await Bun.build({
  entrypoints: ["src/server/index.ts"],
  outdir: "dist",
  naming: { entry: "[name].[ext]" }, // one flat dist/: index.js, index.html and the chunks side by side
  target: "bun",
  plugins: [tailwind],
  external: ["sharp"],
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
for (const o of result.outputs) console.log(o.path.replace(`${process.cwd()}/`, ""), o.size);
