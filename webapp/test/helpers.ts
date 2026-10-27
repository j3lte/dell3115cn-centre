import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { HostKeyStore } from "../src/server/destinations/sftp";
import { configureLog, type LogLevel } from "../src/server/log";
import type { ScanInsert } from "../src/server/repos/scan-repo";
import { TEST_LOG_LEVEL } from "./quiet-log";

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

/** A well-formed SFTP host key fingerprint made of one repeated character, e.g. `fakeFingerprint("a")`. */
export function fakeFingerprint(ch: string): string {
  return `SHA256:${ch.repeat(43)}`;
}

/** An in-memory SFTP host key store (the app's is `HostKeyRepo`). */
export function memoryHostKeys(): HostKeyStore & { keys: Map<string, string> } {
  const keys = new Map<string, string>();
  const k = (host: string, port: number) => `${host.toLowerCase()}:${port}`;
  return {
    keys,
    get: (host, port) => (keys.has(k(host, port)) ? { fingerprint: keys.get(k(host, port))!, firstSeen: 0 } : null),
    set: (host, port, fp) => {
      if (!keys.has(k(host, port))) keys.set(k(host, port), fp);
      return keys.get(k(host, port))!;
    },
    forget: (host, port) => void keys.delete(k(host, port)),
  };
}

/**
 * Captures log lines for the tests of the enclosing scope, without their timestamp (`INFO  scan: …`); the test run's
 * level and normal output come back afterwards.
 */
export function captureLog(level: LogLevel = "info"): string[] {
  const lines: string[] = [];
  beforeEach(() => {
    lines.length = 0;
    configureLog({ level, sink: (l) => lines.push(l.slice(l.indexOf(" ") + 1)) });
  });
  afterEach(() => configureLog({ level: TEST_LOG_LEVEL, sink: (l) => process.stdout.write(`${l}\n`) }));
  return lines;
}
