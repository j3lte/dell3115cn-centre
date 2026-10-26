import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { ScanInsert } from "../src/server/repos/scan-repo";

export function tmpdir(): string {
  return mkdtempSync(join(osTmpdir(), "scan-webapp-test-"));
}

export function tmp(name: string): string {
  return join(tmpdir(), name);
}

export function tables(db: Database): string[] {
  return db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name);
}

/** A scan row for `ScanRepo.insertScan`: a plain UI scan unless `over` says otherwise. */
export function scanInsert(id: string, over: Partial<ScanInsert> = {}): ScanInsert {
  return { id, created_at: 1, input_profile: "{}", output_profile_id: null, review: 0, filter: null, area: null, origin: "ui", expires_at: null, ...over };
}

/**
 * Runs the tests of the enclosing `describe` without the scanner's ICC profile (a Dell file the repository can't ship,
 * so CI never has it): colour pages go through the pipeline untouched.
 */
export function withoutDeviceIcc(): void {
  let before: string | undefined;
  beforeEach(() => {
    before = process.env.DEVICE_ICC;
    process.env.DEVICE_ICC = join(tmpdir(), "no-device-profile.icm"); // a fresh directory: never there
  });
  afterEach(() => {
    if (before === undefined) delete process.env.DEVICE_ICC;
    else process.env.DEVICE_ICC = before;
  });
}
