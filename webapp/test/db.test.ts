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
  expect(db.query<{ version: number }, []>("SELECT version FROM schema_version").get()!.version).toBe(1);
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
  openDb(p).exec("UPDATE schema_version SET version = 3");
  expect(() => openDb(p)).toThrow(/schema version 3/);
});

test("isUuid accepts RFC 4122 shapes only", () => {
  expect(isUuid("3f2b8c1e-9d4a-4c6b-8e2f-1a2b3c4d5e6f")).toBe(true);
  expect(isUuid("not-a-uuid")).toBe(false);
  expect(isUuid(42)).toBe(false);
});
