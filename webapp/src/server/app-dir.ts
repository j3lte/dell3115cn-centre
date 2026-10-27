import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Set to true by build.ts in the production bundle; undefined when running from source. */
declare const BUNDLED: boolean | undefined;
export const bundled = typeof BUNDLED !== "undefined" && BUNDLED;

/** The folder holding `assets/` and `vendor/`: the webapp folder, which is also the parent of the bundle's `dist/`. */
export function appDir(): string {
  return bundled ? dirname(import.meta.dir) : fileURLToPath(new URL("../..", import.meta.url));
}
