import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { downloadHandler, DownloadStore } from "../src/server/downloads";
import { tmpdir } from "./helpers";

function file(name = "scan.pdf", body = "PDFDATA") {
  const path = join(tmpdir(), name);
  writeFileSync(path, body);
  return { path, name, mime: "application/pdf" };
}
const get = (h: (r: Request) => Response, id: string, key: string, method = "GET") => h(new Request(`http://app.local/files/${id}?key=${encodeURIComponent(key)}`, { method }));

test("a link works once, then 410; an owned file is removed after sending", async () => {
  const store = new DownloadStore();
  const f = file();
  const { id, key, size } = store.add({ ...f, owned: true });
  expect(size).toBe(7);
  expect(key.length).toBeGreaterThanOrEqual(22); // >= 128 bits as base64url
  const h = downloadHandler(store);
  const r1 = get(h, id, key);
  expect(r1.status).toBe(200);
  expect(r1.headers.get("content-type")).toBe("application/pdf");
  expect(r1.headers.get("content-disposition")).toContain('filename="scan.pdf"');
  expect(r1.headers.get("cache-control")).toBe("no-store");
  expect(await r1.text()).toBe("PDFDATA");
  expect(existsSync(f.path)).toBe(false);
  expect(get(h, id, key).status).toBe(410);
});

test("files that are not owned stay on disk", async () => {
  const store = new DownloadStore();
  const f = file();
  const { id, key } = store.add({ ...f, owned: false });
  await get(downloadHandler(store), id, key).text();
  expect(existsSync(f.path)).toBe(true);
});

test("wrong key or unknown id → 404 and the link still works; expired → 410", async () => {
  let now = 1000;
  const store = new DownloadStore({ clock: () => now });
  const h = downloadHandler(store);
  const { id, key } = store.add({ ...file(), owned: true });
  expect(get(h, id, "wrong").status).toBe(404);
  expect(get(h, "nope", key).status).toBe(404);
  expect(get(h, id, key, "POST").status).toBe(405);
  const other = store.add({ ...file("other.pdf"), owned: true });
  expect(get(h, other.id, "wrong").status).toBe(404);
  expect(get(h, other.id, other.key).status).toBe(200);
  now += 15 * 60_000 + 1;
  expect(get(h, id, key).status).toBe(410);
});

test("sweep removes expired owned files; clear() invalidates every link", () => {
  let now = 1000;
  const store = new DownloadStore({ clock: () => now });
  const a = file("a.pdf");
  store.add({ ...a, owned: true });
  now += 15 * 60_000 + 1;
  expect(store.sweep()).toBe(1);
  expect(existsSync(a.path)).toBe(false);
  const b = file("b.pdf");
  const { id, key } = store.add({ ...b, owned: true });
  store.clear();
  expect(existsSync(b.path)).toBe(false);
  expect(get(downloadHandler(store), id, key).status).toBe(410);
});

test("a malformed %-escape in the link → 404, not a crash", () => {
  const h = downloadHandler(new DownloadStore());
  expect(h(new Request("http://app.local/files/%E0%A4%A?key=k")).status).toBe(404);
});
