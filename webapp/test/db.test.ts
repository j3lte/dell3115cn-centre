import { expect, test } from "bun:test";
import { isUuid, openDb } from "../src/server/db";
import { tables, tmp } from "./helpers";

test("migrations idempotent", () => {
  const p = tmp("db.sqlite");
  openDb(p).close();
  const db = openDb(p);
  expect(tables(db)).toContain("deliveries");
  for (const t of ["settings", "input_profiles", "output_profiles", "scans", "pages", "deliveries", "schema_version"])
    expect(tables(db)).toContain(t);
  db.close();
});

test("a new database gets the whole schema in one version", () => {
  const db = openDb(":memory:");
  const cols = (t: string) => db.query<{ name: string; dflt_value: string | null }, []>(`PRAGMA table_info(${t})`).all();
  expect(cols("scans").find((c) => c.name === "origin")?.dflt_value).toBe("'ui'");
  for (const c of ["filter", "area", "expires_at"]) expect(cols("scans").some((x) => x.name === c)).toBe(true);
  expect(cols("input_profiles").find((c) => c.name === "depth")?.dflt_value).toBe("8");
  expect(cols("input_profiles").some((c) => c.name === "filter")).toBe(true);
  expect(cols("pages").some((c) => c.name === "filter")).toBe(true);
  expect(db.query<{ version: number }, []>("SELECT version FROM schema_version").get()!.version).toBe(3);
});

const version = (db: ReturnType<typeof openDb>) => db.query<{ version: number }, []>("SELECT version FROM schema_version").get()!.version;
const dedaCols = (db: ReturnType<typeof openDb>) =>
  db.query<{ name: string }, []>("PRAGMA table_info(deda_analyses)").all().map((c) => c.name);

test("a fresh database is at version 3 with deda_analyses and host_keys", () => {
  const db = openDb(":memory:");
  expect(version(db)).toBe(3);
  expect(db.query<{ name: string }, []>("PRAGMA table_info(host_keys)").all().map((c) => c.name)).toEqual(["host", "port", "fingerprint", "first_seen"]);
  expect(dedaCols(db)).toEqual([
    "id", "name", "status", "source", "scan_id", "page", "dpi", "scanned_at", "analysed_at",
    "found", "dots", "grid_score", "decode", "decode_error", "error", "images",
  ]);
  expect(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'deda_scanned'").get()).not.toBeNull();
  db.exec("INSERT INTO deda_analyses (id, name, status, source, scanned_at) VALUES ('d', 'n', 'scanning', 'scan', 1)");
  expect(db.query<{ images: string }, []>("SELECT images FROM deda_analyses").get()!.images).toBe("[]");
});

test("a version-1 database migrates to the latest version and keeps its data", () => {
  const p = tmp("db.sqlite");
  const old = openDb(p);
  old.exec("DROP TABLE deda_analyses; DROP TABLE host_keys; UPDATE schema_version SET version = 1");
  old.exec("INSERT INTO scans (id, created_at, input_profile, status) VALUES ('s', 1, '{}', 'done')");
  old.close();
  const db = openDb(p);
  expect(version(db)).toBe(3);
  expect(tables(db)).toContain("deda_analyses");
  expect(tables(db)).toContain("host_keys");
  expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM scans").get()!.n).toBe(1);
  db.close();
});

test("deleting a scan deletes its pages and deliveries", () => {
  const db = openDb(":memory:");
  db.exec(`
    INSERT INTO scans (id, created_at, input_profile, status) VALUES ('s', 1, '{}', 'done'), ('t', 2, '{}', 'done');
    INSERT INTO pages (scan_id, n, path, width, height, dpi, mode) VALUES ('s', 1, 'p', 1, 1, 75, 'gray'), ('t', 1, 'p', 1, 1, 75, 'gray');
    INSERT INTO deliveries (scan_id, output_profile_name, status, created_at) VALUES ('s', 'Out', 'sent', 1), ('t', 'Out', 'sent', 1);
  `);
  db.exec("DELETE FROM scans WHERE id = 's'");
  const count = (t: string) => db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${t}`).get()!.n;
  expect(count("pages")).toBe(1);
  expect(count("deliveries")).toBe(1);
});

test("pages and deliveries need an existing scan", () => {
  const db = openDb(":memory:");
  expect(() => db.exec("INSERT INTO pages (scan_id, n, path, width, height, dpi, mode) VALUES ('nope', 1, 'p', 1, 1, 75, 'gray')")).toThrow();
  expect(() => db.exec("INSERT INTO deliveries (scan_id, output_profile_name, status, created_at) VALUES ('nope', 'Out', 'sent', 1)")).toThrow();
});

test("a database from another schema version is refused", () => {
  const p = tmp("db.sqlite");
  openDb(p).exec("UPDATE schema_version SET version = 99");
  expect(() => openDb(p)).toThrow(/schema version 99/);
});

test("isUuid accepts RFC 4122 shapes only", () => {
  expect(isUuid("3f2b8c1e-9d4a-4c6b-8e2f-1a2b3c4d5e6f")).toBe(true);
  expect(isUuid("not-a-uuid")).toBe(false);
  expect(isUuid(42)).toBe(false);
});
