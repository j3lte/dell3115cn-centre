import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDestinations } from "../src/server/destinations";
import { createFtpDestination, type FtpClientLike } from "../src/server/destinations/ftp";
import { createSftpDestination, fingerprint, WRITE_CHUNK, type SftpClientLike } from "../src/server/destinations/sftp";
import { SMB_RETIRED } from "../src/server/destinations/smb";
import { DeliveryError, ValidationError } from "../src/server/destinations/types";
import type { OutFile } from "../src/server/output/encode";
import { utils } from "ssh2";
import { fakeFingerprint, memoryHostKeys, tmpdir } from "./helpers";

const getDestination = createDestinations({ hostKeys: memoryHostKeys() });

const meta = { scanId: "scan-1", title: "2026-10-26_0114_scan" };

function outFiles(names: string[]): OutFile[] {
  const d = tmpdir();
  return names.map((name) => {
    const path = join(d, name);
    writeFileSync(path, `content of ${name}`);
    return { name, path, mime: name.endsWith(".pdf") ? "application/pdf" : "image/png" };
  });
}

type Seen = { method: string; path: string; headers: Headers; form?: FormData; json?: unknown };
const servers: { stop(force?: boolean): void }[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.stop(true);
});

function stub(handler: (req: Request, seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const s: Seen = { method: req.method, path: new URL(req.url).pathname, headers: req.headers };
      if ((req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) s.form = await req.formData();
      seen.push(s);
      const res = await handler(req, s);
      // No kept-alive connections: a later test's stub can get the same port, and fetch must not reuse a dead socket.
      res.headers.set("connection", "close");
      return res;
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, seen };
}

describe("download", () => {
  test("send is a no-op, test resolves", async () => {
    const d = getDestination("download");
    expect(d.parse({})).toEqual({});
    await d.test({});
    expect(await d.send(outFiles(["a.pdf"]), {}, meta)).toEqual({});
  });
});

describe("folder", () => {
  test("writes files", async () => {
    const dir = tmpdir();
    const d = getDestination("folder");
    const c = d.parse({ path: dir });
    await d.test(c);
    await d.send(outFiles(["a.pdf", "b.pdf"]), c, meta);
    expect(readdirSync(dir).sort()).toEqual(["a.pdf", "b.pdf"]);
    expect(readFileSync(join(dir, "a.pdf"), "utf8")).toBe("content of a.pdf");
  });

  test("test_folder_never_overwrites", async () => {
    const dir = tmpdir();
    writeFileSync(join(dir, "scan.pdf"), "old");
    const d = getDestination("folder");
    const c = d.parse({ path: dir });
    await d.send(outFiles(["scan.pdf"]), c, meta);
    await d.send(outFiles(["scan.pdf"]), c, meta);
    expect(readdirSync(dir).sort()).toEqual(["scan-2.pdf", "scan-3.pdf", "scan.pdf"]);
    expect(readFileSync(join(dir, "scan.pdf"), "utf8")).toBe("old");
  });

  test("missing folder is an error, not silently created", async () => {
    const d = getDestination("folder");
    const c = d.parse({ path: join(tmpdir(), "not-mounted") });
    await expect(d.test(c)).rejects.toBeInstanceOf(DeliveryError);
    await expect(d.send(outFiles(["a.pdf"]), c, meta)).rejects.toBeInstanceOf(DeliveryError);
  });

  test("relative path rejected", () => {
    expect(() => getDestination("folder").parse({ path: "scans" })).toThrow(ValidationError);
  });
});

describe("paperless", () => {
  test("posts each file with token, title, tags, correspondent", async () => {
    const s = stub(() => Response.json("task-uuid"));
    const d = getDestination("paperless");
    const c = d.parse({ url: s.url + "/", token: "tok", tags: [1, 2], correspondent: 5 });
    const r = await d.send(outFiles(["a.pdf", "b.pdf"]), c, meta);
    expect(s.seen).toHaveLength(2);
    for (const req of s.seen) {
      expect(req.method).toBe("POST");
      expect(req.path).toBe("/api/documents/post_document/");
      expect(req.headers.get("authorization")).toBe("Token tok");
      expect(req.form!.getAll("tags")).toEqual(["1", "2"]);
      expect(req.form!.get("correspondent")).toBe("5");
    }
    expect((s.seen[0]!.form!.get("document") as File).name).toBe("a.pdf");
    expect(await (s.seen[1]!.form!.get("document") as File).text()).toBe("content of b.pdf");
    expect(s.seen[0]!.form!.get("title")).toBe("a");
    expect(r.ref).toContain("task-uuid");
  });

  test("single file uses the scan title", async () => {
    const s = stub(() => Response.json("t"));
    const d = getDestination("paperless");
    await d.send(outFiles(["a.pdf"]), d.parse({ url: s.url, token: "tok" }), meta);
    expect(s.seen[0]!.form!.get("title")).toBe(meta.title);
    expect(s.seen[0]!.form!.has("tags")).toBe(false);
  });

  test("401 -> DeliveryError containing 401", async () => {
    const s = stub(() => new Response("nope", { status: 401, statusText: "Unauthorized" }));
    const d = getDestination("paperless");
    const err = await d.send(outFiles(["a.pdf"]), d.parse({ url: s.url, token: "bad" }), meta).catch((e) => e);
    expect(err).toBeInstanceOf(DeliveryError);
    expect(err.message).toContain("401");
    expect(err.message).toContain("Paperless");
  });

  test("test() = GET /api/ with the token", async () => {
    const s = stub((req) => (req.headers.get("authorization") === "Token good" ? Response.json({}) : new Response("", { status: 401 })));
    const d = getDestination("paperless");
    await d.test(d.parse({ url: s.url, token: "good" }));
    expect(s.seen[0]).toMatchObject({ method: "GET", path: "/api/" });
    await expect(d.test(d.parse({ url: s.url, token: "bad" }))).rejects.toThrow("401");
  });

  test("unreachable host -> DeliveryError 'Cannot reach'", async () => {
    const d = getDestination("paperless");
    const err = await d.test(d.parse({ url: "http://127.0.0.1:1", token: "t" })).catch((e) => e);
    expect(err).toBeInstanceOf(DeliveryError);
    expect(err.message).toContain("Cannot reach 127.0.0.1");
  });

  test("parse validates url and token", () => {
    const d = getDestination("paperless");
    expect(() => d.parse({ url: "ftp://x", token: "t" })).toThrow(ValidationError);
    expect(() => d.parse({ url: "http://x" })).toThrow(ValidationError);
    expect(d.parse({ url: "http://x", token: "t", tags: "1, 2" }).tags).toEqual([1, 2]);
  });
});

describe("papra", () => {
  test("posts file with bearer key to the organisation", async () => {
    const s = stub(() => Response.json({ document: { id: "doc_1" } }));
    const d = getDestination("papra");
    const r = await d.send(outFiles(["a.pdf"]), d.parse({ url: s.url, apiKey: "k", organizationId: "org_9" }), meta);
    expect(s.seen[0]).toMatchObject({ method: "POST", path: "/api/organizations/org_9/documents" });
    expect(s.seen[0]!.headers.get("authorization")).toBe("Bearer k");
    expect((s.seen[0]!.form!.get("file") as File).name).toBe("a.pdf");
    expect(r.ref).toContain("doc_1");
  });

  test("test() checks the organisation is listed", async () => {
    const s = stub(() => Response.json({ organizations: [{ id: "org_9", name: "Home" }] }));
    const d = getDestination("papra");
    await d.test(d.parse({ url: s.url, apiKey: "k", organizationId: "org_9" }));
    expect(s.seen[0]).toMatchObject({ method: "GET", path: "/api/organizations" });
    await expect(d.test(d.parse({ url: s.url, apiKey: "k", organizationId: "org_other" }))).rejects.toBeInstanceOf(DeliveryError);
  });
});

describe("webhook", () => {
  test("one multipart POST with all files and meta, optional header", async () => {
    const s = stub(() => new Response("ok"));
    const d = getDestination("webhook");
    await d.send(outFiles(["a.png", "b.png"]), d.parse({ url: s.url + "/hook", headerName: "X-Key", headerValue: "v" }), meta);
    expect(s.seen).toHaveLength(1);
    expect(s.seen[0]).toMatchObject({ method: "POST", path: "/hook" });
    expect(s.seen[0]!.headers.get("x-key")).toBe("v");
    expect((s.seen[0]!.form!.getAll("file") as File[]).map((f) => f.name)).toEqual(["a.png", "b.png"]);
    expect(JSON.parse(s.seen[0]!.form!.get("meta") as string)).toEqual({ scanId: "scan-1", title: meta.title, files: ["a.png", "b.png"] });
  });

  test("test() posts meta only with test:true", async () => {
    const s = stub(() => new Response("ok"));
    const d = getDestination("webhook");
    await d.test(d.parse({ url: s.url }));
    expect(s.seen[0]!.form!.getAll("file")).toEqual([]);
    expect(JSON.parse(s.seen[0]!.form!.get("meta") as string)).toEqual({ test: true });
  });

  test("500 -> DeliveryError", async () => {
    const s = stub(() => new Response("boom", { status: 500, statusText: "Internal Server Error" }));
    const d = getDestination("webhook");
    await expect(d.send(outFiles(["a.png"]), d.parse({ url: s.url }), meta)).rejects.toThrow("500");
  });
});

describe("smb (retired)", () => {
  test("parse, test and send all refuse with the retired message", async () => {
    const d = getDestination("smb");
    expect(d.retired).toBe(SMB_RETIRED);
    expect(() => d.parse({ server: "nas.example", share: "scans" })).toThrow(ValidationError);
    expect(() => d.parse({})).toThrow(SMB_RETIRED);
    await expect(d.test({} as never)).rejects.toThrow(SMB_RETIRED);
    const err = await d.send(outFiles(["a.pdf"]), {} as never, meta).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeliveryError);
    expect((err as Error).message).toBe(SMB_RETIRED);
  });
});

/**
 * A fresh ed25519 key. ssh2's generator writes a malformed key about 1 time in 256 (a public key with a leading zero
 * byte loses it), so keys that don't parse are thrown away; keys from ssh-keygen don't have this problem.
 */
function testKey(passphrase?: string): string {
  for (;;) {
    const k = passphrase
      ? utils.generateKeyPairSync("ed25519", { passphrase, cipher: "aes256-cbc", rounds: 16 }).private
      : utils.generateKeyPairSync("ed25519").private;
    if (!(utils.parseKey(k, passphrase) instanceof Error)) return k;
  }
}

describe("sftp", () => {
  const KEY_A = fakeFingerprint("A");
  const KEY_B = fakeFingerprint("B");

  type Fake = { log: string[]; files: Map<string, Buffer>; writes: { path: string; position: number; length: number }[]; client: () => SftpClientLike };
  type FakeOptions = {
    hostKey?: string;
    fail?: Error;
    files?: string[];
    dirs?: string[];
    readOnly?: boolean;
    listMisses?: boolean;
    /** write() fails from this offset on (disk full). */
    failWriteAt?: number;
    failClose?: boolean;
    /** Upload-only server: remove() is refused. */
    noDelete?: boolean;
  };
  function fakeServer(o: FakeOptions = {}): Fake {
    const dirs = new Set(o.dirs ?? [".", "scans"]);
    const open = new Map<string, string>(); // handle → path
    const fake: Fake = {
      log: [],
      files: new Map((o.files ?? []).map((f) => [f, Buffer.from("old")])),
      writes: [],
      client: () => ({
        async connect(c) {
          fake.log.push(`connect ${c.username}@${c.host}:${c.port}${c.password ? " password" : ""}${c.privateKey ? " key" : ""}`);
          if (!c.verifyHostKey(o.hostKey ?? KEY_A)) throw new Error("Host denied (verification failed)");
          if (o.fail) throw o.fail;
        },
        async isDirectory(path) {
          fake.log.push(`stat ${path}`);
          if (dirs.has(path)) return true;
          if (fake.files.has(path)) return false;
          throw Object.assign(new Error("No such file"), { code: 2 });
        },
        async list(path) {
          if (o.listMisses) return [];
          const prefix = path === "." ? "" : `${path}/`;
          return [...fake.files.keys()].filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes("/")).map((f) => f.slice(prefix.length));
        },
        async exists(path) {
          return fake.files.has(path) || dirs.has(path);
        },
        async create(path) {
          await Bun.sleep(1);
          if (o.readOnly) throw Object.assign(new Error("Permission denied"), { code: 3 });
          if (fake.files.has(path)) throw Object.assign(new Error("Failure"), { code: 4 });
          fake.files.set(path, Buffer.alloc(0));
          fake.log.push(`create ${path}`);
          const handle = Buffer.from(`h${open.size}`);
          open.set(handle.toString(), path);
          return handle;
        },
        async write(handle, data, position) {
          const path = open.get(handle.toString())!;
          fake.writes.push({ path, position, length: data.length });
          if (o.failWriteAt !== undefined && position >= o.failWriteAt) throw Object.assign(new Error("No space left on device"), { code: 4 });
          await Bun.sleep(Math.random() * 3); // writes in flight finish in any order
          const cur = fake.files.get(path)!;
          const next = Buffer.alloc(Math.max(cur.length, position + data.length));
          cur.copy(next);
          data.copy(next, position);
          fake.files.set(path, next);
        },
        async closeFile(handle) {
          open.delete(handle.toString());
          if (o.failClose) throw new Error("close failed");
        },
        async remove(path) {
          if (o.noDelete) throw Object.assign(new Error("Permission denied"), { code: 3 });
          fake.files.delete(path);
          fake.log.push(`remove ${path}`);
        },
        close() {
          fake.log.push("close");
        },
      }),
    };
    return fake;
  }
  const config = { host: "files.example", path: "scans", username: "scanner", password: "pw" };
  const text = (b: Buffer | undefined) => b?.toString();

  describe("parse", () => {
    const d = createSftpDestination(memoryHostKeys(), fakeServer().client);
    test("defaults: port 22, path '.'", () => {
      expect(d.parse({ host: "files.example", username: "u", password: "p" })).toEqual({
        host: "files.example",
        port: 22,
        path: ".",
        username: "u",
        password: "p",
        privateKey: "",
        passphrase: "",
      });
    });
    test("rejects a bad host, port, user and missing credentials", () => {
      expect(() => d.parse({ ...config, host: "a b" })).toThrow("Host must be a host name or IP address");
      expect(() => d.parse({ ...config, port: 70000 })).toThrow("Port must be 1-65535");
      expect(() => d.parse({ ...config, port: "x" })).toThrow("Port must be 1-65535");
      expect(() => d.parse({ ...config, username: "" })).toThrow("User name is required");
      expect(() => d.parse({ ...config, password: "" })).toThrow("Enter a password or a private key");
    });
    test("a private key must be a key block that opens (with its passphrase)", () => {
      const plain = testKey();
      const locked = testKey("secret");
      expect(d.parse({ ...config, password: "", privateKey: plain }).privateKey).toBe(plain.trim());
      expect(() => d.parse({ ...config, password: "", privateKey: "ssh-ed25519 AAAA… user@host" })).toThrow("The private key must be the text of a key file");
      expect(() => d.parse({ ...config, password: "", privateKey: locked })).toThrow("The private key is encrypted: enter its passphrase");
      expect(() => d.parse({ ...config, password: "", privateKey: locked, passphrase: "wrong" })).toThrow(/private key/);
      expect(d.parse({ ...config, password: "", privateKey: locked, passphrase: "secret" }).passphrase).toBe("secret");
    });
  });

  test("test() checks the folder is writable with a temporary file it removes again", async () => {
    const fake = fakeServer();
    const d = createSftpDestination(memoryHostKeys(), fake.client);
    await d.test(d.parse(config));
    expect(fake.log[0]).toBe("connect scanner@files.example:22 password");
    expect(fake.log[1]).toBe("stat scans");
    expect(fake.log[2]).toMatch(/^create scans\/\.centre-test-[0-9a-f]+$/);
    expect(fake.log[3]).toBe(`remove ${fake.log[2]!.slice(7)}`);
    expect(fake.log.at(-1)).toBe("close");
    expect(fake.files.size).toBe(0);
  });

  test("test() refuses a missing folder, a file and a read-only folder", async () => {
    const d = createSftpDestination(memoryHostKeys(), fakeServer({ files: ["scans.txt"] }).client);
    await expect(d.test(d.parse({ ...config, path: "nope" }))).rejects.toThrow("SFTP: folder nope does not exist");
    await expect(d.test(d.parse({ ...config, path: "scans.txt" }))).rejects.toThrow("SFTP: scans.txt is not a folder");
    const ro = createSftpDestination(memoryHostKeys(), fakeServer({ readOnly: true }).client);
    await expect(ro.test(ro.parse(config))).rejects.toThrow("SFTP: cannot write in scans: Permission denied");
  });

  describe("host key, trusted on first use per host:port", () => {
    test("the first connection stores the server's key; the same key passes again", async () => {
      const keys = memoryHostKeys();
      const d = createSftpDestination(keys, fakeServer().client);
      await d.test(d.parse(config));
      expect(keys.get("files.example", 22)?.fingerprint).toBe(KEY_A);
      expect(keys.get("files.example", 2222)).toBeNull();
      await d.test(d.parse(config));
    });

    test("a different key is refused before logging in, nothing is uploaded, and the stored key stays", async () => {
      const keys = memoryHostKeys();
      keys.set("files.example", 22, KEY_A);
      const fake = fakeServer({ hostKey: KEY_B });
      const d = createSftpDestination(keys, fake.client);
      const err = await d.send(outFiles(["a.pdf"]), d.parse(config), meta).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DeliveryError);
      expect((err as Error).message).toBe(
        `Host key of files.example changed (expected ${KEY_A}, got ${KEY_B}). If this is expected, use "Forget host key" in the output profile.`,
      );
      expect(fake.files.size).toBe(0);
      expect(fake.log.at(-1)).toBe("close");
      expect(keys.get("files.example", 22)?.fingerprint).toBe(KEY_A);
    });

    test("forgetting it trusts the next key", async () => {
      const keys = memoryHostKeys();
      keys.set("files.example", 22, KEY_A);
      keys.forget("files.example", 22);
      const d = createSftpDestination(keys, fakeServer({ hostKey: KEY_B }).client);
      await d.test(d.parse(config));
      expect(keys.get("files.example", 22)?.fingerprint).toBe(KEY_B);
    });

    test("a failed login stores nothing", async () => {
      const keys = memoryHostKeys();
      const auth = Object.assign(new Error("All configured authentication methods failed"), { level: "client-authentication" });
      const d = createSftpDestination(keys, fakeServer({ fail: auth }).client);
      await expect(d.test(d.parse(config))).rejects.toThrow("SFTP: login as scanner failed (wrong password or key)");
      expect(keys.keys.size).toBe(0);
    });
  });

  test("send() uploads with the FTP numbering, never overwriting", async () => {
    const fake = fakeServer({ files: ["scans/scan.pdf", "scans/scan-2.pdf"] });
    const d = createSftpDestination(memoryHostKeys(), fake.client);
    expect(await d.send(outFiles(["scan.pdf", "other.pdf"]), d.parse(config), meta)).toEqual({ ref: "scan-3.pdf, other.pdf" });
    expect(text(fake.files.get("scans/scan.pdf"))).toBe("old");
    expect(text(fake.files.get("scans/scan-3.pdf"))).toBe("content of scan.pdf");
    expect(text(fake.files.get("scans/other.pdf"))).toBe("content of other.pdf");
  });

  test("send() to the login folder", async () => {
    const d = createSftpDestination(memoryHostKeys(), fakeServer({ files: ["scan.pdf"] }).client);
    expect(await d.send(outFiles(["scan.pdf"]), d.parse({ ...config, path: "" }), meta)).toEqual({ ref: "scan-2.pdf" });
  });

  test("a large file arrives complete, in WRITE_CHUNK pieces at increasing offsets", async () => {
    const fake = fakeServer();
    const d = createSftpDestination(memoryHostKeys(), fake.client);
    const [f] = outFiles(["big.bin"]);
    const data = randomBytes(WRITE_CHUNK * 20 + 1234);
    writeFileSync(f!.path, data);
    await d.send([f!], d.parse(config), meta);
    expect(fake.files.get("scans/big.bin")!.equals(data)).toBe(true);
    expect(fake.writes.map((w) => w.position)).toEqual(Array.from({ length: 21 }, (_, i) => i * WRITE_CHUNK));
    expect(fake.writes.at(-1)!.length).toBe(1234);
  });

  test("a name taken between listing and upload moves on to the next number", async () => {
    const fake = fakeServer({ files: ["scans/scan.pdf"], listMisses: true });
    const d = createSftpDestination(memoryHostKeys(), fake.client);
    expect((await d.send(outFiles(["scan.pdf"]), d.parse(config), meta)).ref).toBe("scan-2.pdf");
    expect(text(fake.files.get("scans/scan.pdf"))).toBe("old");
  });

  test("two deliveries of the same name at once get different names", async () => {
    const fake = fakeServer();
    const d = createSftpDestination(memoryHostKeys(), fake.client);
    const c = d.parse(config);
    await Promise.all([d.send(outFiles(["scan.pdf"]), c, meta), d.send(outFiles(["scan.pdf"]), c, meta)]);
    expect([...fake.files.keys()].sort()).toEqual(["scans/scan-2.pdf", "scans/scan.pdf"]);
  });

  test("a write that fails halfway is reported as such, its partial file removed, and no other name tried", async () => {
    const fake = fakeServer({ failWriteAt: WRITE_CHUNK });
    const d = createSftpDestination(memoryHostKeys(), fake.client);
    const [f] = outFiles(["big.bin"]);
    writeFileSync(f!.path, randomBytes(WRITE_CHUNK * 3));
    await expect(d.send([f!], d.parse(config), meta)).rejects.toThrow("SFTP: No space left on device");
    expect(fake.log.filter((l) => l.startsWith("create "))).toEqual(["create scans/big.bin"]);
    expect([...fake.files.keys()]).toEqual([]);
  });

  test("a failing close doesn't hide the write error that came first", async () => {
    const fake = fakeServer({ failWriteAt: 0, failClose: true });
    const d = createSftpDestination(memoryHostKeys(), fake.client);
    await expect(d.send(outFiles(["a.pdf"]), d.parse(config), meta)).rejects.toThrow("SFTP: No space left on device");
  });

  test("on an upload-only server Test passes with a note naming the test file it couldn't remove", async () => {
    const fake = fakeServer({ noDelete: true });
    const d = createSftpDestination(memoryHostKeys(), fake.client);
    const r = await d.test(d.parse(config));
    const probe = [...fake.files.keys()][0]!;
    expect(probe).toMatch(/^scans\/\.centre-test-[0-9a-f]+$/);
    expect(r).toEqual({ note: `Writing works, but this user may not delete files: remove the test file ${probe} on the server yourself.` });
  });

  test("Test removes its test file even when closing it fails", async () => {
    const fake = fakeServer({ failClose: true });
    const d = createSftpDestination(memoryHostKeys(), fake.client);
    await d.test(d.parse(config));
    expect(fake.files.size).toBe(0);
  });

  test("two first connections that see different keys: the second is refused before uploading", async () => {
    const keys = memoryHostKeys();
    const racing = { ...keys, get: () => null }; // both connections looked before either stored
    keys.set("files.example", 22, KEY_B); // the other connection won
    const fake = fakeServer({ hostKey: KEY_A });
    const d = createSftpDestination(racing, fake.client);
    await expect(d.send(outFiles(["a.pdf"]), d.parse(config), meta)).rejects.toThrow(`Host key of files.example changed (expected ${KEY_B}, got ${KEY_A})`);
    expect(fake.files.size).toBe(0);
  });

  test("network and timeout errors", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:22"), { code: "ECONNREFUSED" });
    let d = createSftpDestination(memoryHostKeys(), fakeServer({ fail: refused }).client);
    await expect(d.test(d.parse(config))).rejects.toThrow("Cannot reach files.example: ECONNREFUSED");
    const timeout = Object.assign(new Error("Timed out while waiting for handshake"), { level: "client-timeout" });
    d = createSftpDestination(memoryHostKeys(), fakeServer({ fail: timeout }).client);
    await expect(d.test(d.parse(config))).rejects.toThrow("Cannot reach files.example: timed out");
  });

  test("fingerprint() is OpenSSH's SHA256 form", () => {
    const key = Buffer.from("not really a key");
    const hash = createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
    expect(fingerprint(key)).toBe(`SHA256:${hash}`);
  });
});

describe("ftp", () => {
  function clientStub(existing: string[], fail?: Error) {
    const log: string[] = [];
    const client: FtpClientLike = {
      async access(o) {
        log.push(`access ${o.host}:${o.port} ${o.user} secure=${o.secure}`);
        if (fail) throw fail;
      },
      async ensureDir(p) {
        log.push(`ensureDir ${p}`);
      },
      async list() {
        return existing.map((name) => ({ name }));
      },
      async uploadFrom(local, remote) {
        log.push(`upload ${local.split("/").pop()} -> ${remote}`);
        existing.push(remote);
      },
      close() {
        log.push("close");
      },
    };
    return { log, factory: () => client };
  }
  const config = { host: "ftp.example", path: "/scans", username: "u", password: "p", secure: true };

  test("two deliveries of the same name at once get different names", async () => {
    const existing: string[] = [];
    const factory = (): FtpClientLike => ({
      async access() {},
      async ensureDir() {},
      async list() {
        await Bun.sleep(5);
        return existing.map((name) => ({ name }));
      },
      async uploadFrom(_local, remote) {
        await Bun.sleep(5);
        existing.push(remote);
      },
      close() {},
    });
    const d = createFtpDestination(factory);
    const c = d.parse(config);
    await Promise.all([d.send(outFiles(["scan.pdf"]), c, meta), d.send(outFiles(["scan.pdf"]), c, meta)]);
    expect(existing.sort()).toEqual(["scan-2.pdf", "scan.pdf"]);
  });

  test("ensureDir then uploads with collision-free names", async () => {
    const { log, factory } = clientStub(["scan.pdf"]);
    const d = createFtpDestination(factory);
    await d.send(outFiles(["scan.pdf", "other.pdf"]), d.parse(config), meta);
    expect(log).toEqual([
      "access ftp.example:21 u secure=true",
      "ensureDir /scans",
      "upload scan.pdf -> scan-2.pdf",
      "upload other.pdf -> other.pdf",
      "close",
    ]);
  });

  test("connection refused -> Cannot reach", async () => {
    const e = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:21"), { code: "ECONNREFUSED" });
    const { log, factory } = clientStub([], e);
    const d = createFtpDestination(factory);
    const err = await d.test(d.parse(config)).catch((x) => x);
    expect(err).toBeInstanceOf(DeliveryError);
    expect(err.message).toBe("Cannot reach ftp.example: ECONNREFUSED");
    expect(log.at(-1)).toBe("close");
  });

  test("login failure -> FTP error text", async () => {
    const e = Object.assign(new Error("530 Login incorrect."), { code: 530 });
    const d = createFtpDestination(clientStub([], e).factory);
    await expect(d.test(d.parse(config))).rejects.toThrow("FTP: 530 Login incorrect.");
  });
});

describe("real servers (optional)", () => {
  test.skipIf(!process.env.TEST_SFTP_URL)("sftp roundtrip", { timeout: 120000 }, async () => {
    // TEST_SFTP_URL=sftp://user:pass@server:port/path
    const u = new URL(process.env.TEST_SFTP_URL!);
    const keys = memoryHostKeys();
    const d = createDestinations({ hostKeys: keys })("sftp");
    const c = d.parse({ host: u.hostname, port: Number(u.port || 22), path: u.pathname.slice(1) || ".", username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) });
    await d.test(c);
    const trusted = keys.get(c.host, c.port)!.fingerprint;
    expect(trusted).toMatch(/^SHA256:/);
    const big = outFiles(["webapp-test-big.bin"])[0]!;
    const bytes = randomBytes(24 * 1024 * 1024 + 5); // ~100 write chunks
    writeFileSync(big.path, bytes);
    console.log(`webapp-test-big.bin sha256 ${createHash("sha256").update(bytes).digest("hex")}`);
    const first = await d.send([...outFiles(["webapp-test.txt"]), big], c, meta);
    const second = await d.send(outFiles(["webapp-test.txt"]), c, meta);
    expect(first.ref).not.toBe(second.ref);
    expect(second.ref).toMatch(/^webapp-test-\d+\.txt$/);
    keys.forget(c.host, c.port);
    keys.set(c.host, c.port, fakeFingerprint("A"));
    await expect(d.test(c)).rejects.toThrow(`Host key of ${u.hostname} changed (expected ${fakeFingerprint("A")}, got ${trusted})`);
  });
  test.skipIf(!process.env.TEST_FTP_URL)("ftp roundtrip", async () => {
    const u = new URL(process.env.TEST_FTP_URL!);
    const d = getDestination("ftp");
    const c = d.parse({ host: u.hostname, port: Number(u.port || 21), path: u.pathname || "/", username: decodeURIComponent(u.username), password: decodeURIComponent(u.password), secure: false });
    await d.test(c);
    await d.send(outFiles(["webapp-test.txt"]), c, meta);
  });
});

test("the registry lists its retired destinations with their message", () => {
  expect(getDestination.retired).toEqual({ smb: SMB_RETIRED });
});

test("every destination type is registered", () => {
  for (const t of ["download", "folder", "smb", "sftp", "ftp", "paperless", "papra", "webhook"] as const) expect(getDestination(t).type).toBe(t);
  mkdirSync(tmpdir(), { recursive: true });
});
