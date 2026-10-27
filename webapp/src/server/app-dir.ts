import { fileURLToPath } from "node:url";

/**
 * The app folder holding `assets/` and `vendor/`: env APP_DIR (the Docker image runs a bundle from `dist/` and sets
 * it), else the webapp folder this source file lives in.
 */
export function appDir(env: Record<string, string | undefined> = process.env): string {
  return env.APP_DIR || fileURLToPath(new URL("../..", import.meta.url));
}
