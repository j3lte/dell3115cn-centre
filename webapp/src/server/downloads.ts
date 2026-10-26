import { randomBytes } from "node:crypto";
import { existsSync, rmdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

export type DownloadFile = { path: string; name: string; mime: string; owned: boolean };
type Entry = DownloadFile & { key: string; expiresAt: number };

const TTL_MS = 15 * 60_000;

/** `attachment` header with an ASCII fallback name and the exact UTF-8 name. */
export function contentDisposition(name: string): string {
  return `attachment; filename="${name.replace(/[^\x20-\x7e]|"/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Removes an owned file, and its directory once that is empty (exports get a directory each). */
function discard(f: DownloadFile): void {
  if (!f.owned) return;
  rmSync(f.path, { force: true });
  try {
    rmdirSync(dirname(f.path));
  } catch {
    // not empty: other files of the same export are still waiting
  }
}

/**
 * One-time download links for assistants: each link works for exactly one successful GET and expires unused after
 * `ttlMs`. In memory only, so a restart invalidates every link. Files the store owns are deleted when their link is
 * used, expires or is cleared.
 */
export class DownloadStore {
  private entries = new Map<string, Entry>();
  /** Ids that were used, expired or cleared: they answer 410 instead of 404 until the store forgets them. */
  private gone = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly clock: () => number;

  constructor(opts: { ttlMs?: number; clock?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? TTL_MS;
    this.clock = opts.clock ?? Date.now;
  }

  add(file: DownloadFile): { id: string; key: string; size: number } {
    const id = crypto.randomUUID();
    const key = randomBytes(32).toString("base64url");
    this.entries.set(id, { ...file, key, expiresAt: this.clock() + this.ttlMs });
    return { id, key, size: statSync(file.path).size };
  }

  /** The file for a valid id + key (removed from the store), "gone" when used/expired/cleared, null when unknown. */
  take(id: string, key: string): DownloadFile | "gone" | null {
    const e = this.entries.get(id);
    if (!e) return this.gone.has(id) ? "gone" : null;
    if (e.expiresAt <= this.clock()) {
      this.retire(id, e);
      return "gone";
    }
    if (e.key !== key) return null;
    this.entries.delete(id);
    this.gone.set(id, this.clock() + this.ttlMs);
    return { path: e.path, name: e.name, mime: e.mime, owned: e.owned };
  }

  /** Drops expired links (and their owned files). Returns how many. */
  sweep(): number {
    const now = this.clock();
    let n = 0;
    for (const [id, e] of this.entries)
      if (e.expiresAt <= now) {
        this.retire(id, e);
        n++;
      }
    for (const [id, until] of this.gone) if (until <= now) this.gone.delete(id);
    return n;
  }

  /** Invalidates every link (MCP switched off or its key regenerated). */
  clear(): void {
    for (const [id, e] of this.entries) this.retire(id, e);
  }

  private retire(id: string, e: Entry): void {
    this.entries.delete(id);
    this.gone.set(id, this.clock() + this.ttlMs);
    discard(e);
  }
}

/** `GET /files/<id>?key=…`: 200 with the file once, 410 when used/expired, 404 when unknown or the key is wrong. */
export function downloadHandler(store: DownloadStore): (req: Request) => Response {
  return (req) => {
    if (req.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });
    const url = new URL(req.url);
    const id = decodePath(url.pathname.replace(/^\/files\//, "").replace(/\/$/, ""));
    const got = id === null ? null : store.take(id, url.searchParams.get("key") ?? "");
    if (got === null) return new Response("Not found", { status: 404 });
    if (got === "gone") return new Response("This link was already used or has expired; ask for a new one", { status: 410 });
    // A delivered file disappears with its scan.
    if (!existsSync(got.path)) return new Response("The file no longer exists", { status: 410 });
    const source = Bun.file(got.path).stream().getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        const { done, value } = await source.read();
        if (done) {
          c.close();
          discard(got);
        } else c.enqueue(value);
      },
      cancel() {
        void source.cancel();
        discard(got);
      },
    });
    return new Response(body, {
      headers: { "content-type": got.mime, "content-disposition": contentDisposition(got.name), "cache-control": "no-store" },
    });
  };
}

/** decodeURIComponent, or null for a malformed %-escape (a bad link is "not found", not a server error). */
export function decodePath(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}
