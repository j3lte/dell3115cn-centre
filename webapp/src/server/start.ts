// Entry of the production bundle (build.ts). Bun finds the bundled UI's files relative to the working directory, so
// this moves into the bundle's folder before loading the server, after making the path settings absolute.
import { resolve } from "node:path";

for (const key of ["DATA_DIR", "DEVICE_ICC", "SRGB_ICC"]) {
  const value = process.env[key];
  if (value) process.env[key] = resolve(value);
}
process.chdir(import.meta.dir);
await import("./index");
