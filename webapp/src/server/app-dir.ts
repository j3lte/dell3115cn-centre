import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Set to true by build.ts in the production bundle; undefined when running from source. */
declare const BUNDLED: boolean | undefined;
export const bundled = typeof BUNDLED !== "undefined" && BUNDLED;

/** The folder holding `assets/`: the webapp folder, which is also the parent of the bundle's `dist/`. */
export const appDir = bundled ? dirname(import.meta.dir) : fileURLToPath(new URL("../..", import.meta.url));
