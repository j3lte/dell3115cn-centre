import { constants, copyFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { asObject, candidateName, DeliveryError, str, ValidationError, type Destination } from "./types";

export type FolderConfig = { path: string };

/** The folder must already exist (a mounted volume); it is never created, so a missing mount can't swallow scans. */
function checkDir(path: string): void {
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new DeliveryError(`Folder ${path} does not exist (is the volume mounted?)`);
  }
  if (!st.isDirectory()) throw new DeliveryError(`${path} is not a folder`);
}

export const folder: Destination<FolderConfig> = {
  type: "folder",
  parse(config) {
    const o = asObject(config);
    const path = str(o, "path", "Folder path");
    if (!isAbsolute(path)) throw new ValidationError("Folder path must be absolute (a path inside the container, e.g. /scans)");
    return { path };
  },
  async test(c) {
    checkDir(c.path);
    const probe = join(c.path, `.scan-webapp-test-${process.pid}-${Date.now()}`);
    try {
      writeFileSync(probe, "test");
      unlinkSync(probe);
    } catch (e) {
      throw new DeliveryError(`Folder ${c.path} is not writable: ${(e as NodeJS.ErrnoException).code ?? e}`);
    }
  },
  async send(files, c) {
    checkDir(c.path);
    const written: string[] = [];
    for (const f of files) {
      for (let i = 1; ; i++) {
        const name = candidateName(f.name, i);
        try {
          // COPYFILE_EXCL: never overwrite, also when two scans race for the same name
          copyFileSync(f.path, join(c.path, name), constants.COPYFILE_EXCL);
          written.push(name);
          break;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw new DeliveryError(`Cannot write ${name} to ${c.path}: ${(e as NodeJS.ErrnoException).code ?? e}`);
        }
      }
    }
    return { ref: written.join(", ") };
  },
};

