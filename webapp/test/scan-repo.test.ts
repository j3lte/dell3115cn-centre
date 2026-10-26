import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { openDb } from "../src/server/db";
import { ScanRepo } from "../src/server/repos/scan-repo";
import { scanInsert, tmpdir } from "./helpers";

let db: ReturnType<typeof openDb>;
afterEach(() => db?.close());

function make() {
  db = openDb(join(tmpdir(), "db.sqlite"));
  return new ScanRepo(db);
}

const scan = scanInsert;

function page(scanId: string, n: number) {
  return { scan_id: scanId, n, path: `${scanId}/${n}.png`, width: 10, height: 20, dpi: 150, mode: "gray" as const, rotation: 0 };
}

test("recoverInterrupted fails scanning and delivering scans and sending deliveries", () => {
  const repo = make();
  repo.insertScan(scan("a"));
  repo.insertScan(scan("b"));
  repo.updateScan("b", { status: "delivering" });
  const did = repo.insertDelivery("b", 1, "Out", 5);
  repo.recoverInterrupted();
  expect(repo.scan("a")).toMatchObject({ status: "failed", error: "Interrupted by a restart" });
  expect(repo.scan("b")).toMatchObject({ status: "failed", error: "Interrupted by a restart" });
  expect(repo.deliveries("b")[0]).toMatchObject({ id: did, status: "failed", error: "Interrupted by a restart" });
});

test("recoverInterrupted keeps the pages of an interrupted scan for review, or ready for an assistant", () => {
  const repo = make();
  repo.insertScan(scan("ui"));
  repo.insertScan(scan("mcp", { origin: "mcp" }));
  repo.updateScan("ui", { page_count: 2, problem: "Feeder jam" });
  repo.updateScan("mcp", { page_count: 1 });
  repo.recoverInterrupted();
  expect(repo.scan("ui")).toMatchObject({ status: "review", review: 1, problem: "Feeder jam; Scan interrupted by a restart", error: null });
  expect(repo.scan("mcp")).toMatchObject({ status: "ready", review: 1, problem: "Scan interrupted by a restart", error: null });
});

test("list pages by seq and hides temporary scans", () => {
  const repo = make();
  for (const [i, id] of ["a", "b", "c"].entries()) repo.insertScan(scan(id, { created_at: 10 + i }));
  repo.insertScan(scan("tmp", { created_at: 99, expires_at: 1000 }));
  const first = repo.list(2);
  expect(first.map((r) => r.id)).toEqual(["c", "b"]);
  const rest = repo.list(2, first[first.length - 1]!.created_at);
  expect(rest.map((r) => r.id)).toEqual(["a"]);
  expect(first[0]!.seq).toBeGreaterThan(first[1]!.seq);
});

test("renumberPages applies the new order", () => {
  const repo = make();
  repo.insertScan(scan("a"));
  for (const n of [1, 2, 3]) repo.insertPage(page("a", n));
  repo.renumberPages("a", [3, 1, 2]);
  expect(repo.pages("a").map((p) => p.path)).toEqual(["a/3.png", "a/1.png", "a/2.png"]);
  expect(repo.page("a", 1)?.path).toBe("a/3.png");
});

test("deleteScan removes its pages and deliveries", () => {
  const repo = make();
  repo.insertScan(scan("a"));
  repo.insertScan(scan("b"));
  repo.insertPage(page("a", 1));
  repo.insertPage(page("b", 1));
  repo.insertDelivery("a", 1, "Out", 5);
  repo.deleteScan("a");
  expect(repo.scan("a")).toBeNull();
  expect(repo.pages("a")).toEqual([]);
  expect(repo.deliveries("a")).toEqual([]);
  expect(repo.pages("b")).toHaveLength(1);
});

test("idsOlderThan skips scanning and delivering scans", () => {
  const repo = make();
  for (const [id, status] of [["s", "scanning"], ["d", "delivering"], ["r", "review"], ["x", "done"]] as const) {
    repo.insertScan(scan(id, { created_at: 1 }));
    repo.updateScan(id, { status });
  }
  repo.insertScan(scan("new", { created_at: 100 }));
  repo.updateScan("new", { status: "done" });
  expect(repo.idsOlderThan(50).sort()).toEqual(["r", "x"]);
});

test("hasSentDelivery is false until a delivery is marked sent", () => {
  const repo = make();
  repo.insertScan(scan("a"));
  const did = repo.insertDelivery("a", 1, "Out", 5);
  expect(repo.hasSentDelivery("a")).toBe(false);
  repo.markDeliveryFailed(did, "boom", "[]");
  expect(repo.hasSentDelivery("a")).toBe(false);
  repo.markDeliverySent(did);
  expect(repo.hasSentDelivery("a")).toBe(true);
});
