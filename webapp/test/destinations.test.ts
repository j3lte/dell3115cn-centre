import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDestination } from "../src/server/destinations";
import { createFtpDestination, type FtpClientLike } from "../src/server/destinations/ftp";
import { createSmbDestination, type CommandRunner } from "../src/server/destinations/smb";
import { DeliveryError, ValidationError } from "../src/server/destinations/types";
import type { OutFile } from "../src/server/output/encode";
import { tmpdir } from "./helpers";

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
      return handler(req, s);
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

describe("smb", () => {
  function runnerStub(respond: (argv: string[], authfile: string) => { code: number; stdout: string; stderr?: string }) {
    const calls: { argv: string[]; authfile: string }[] = [];
    const runner: CommandRunner = async (argv) => {
      const authPath = argv[argv.indexOf("-A") + 1]!;
      const authfile = argv.includes("-A") ? readFileSync(authPath, "utf8") : "";
      calls.push({ argv, authfile });
      const r = respond(argv, authfile);
      return { code: r.code, stdout: r.stdout, stderr: r.stderr ?? "" };
    };
    return { calls, runner };
  }
  const config = { server: "nas.example", share: "scans", path: "inbox/2026", username: "user", password: "pw", domain: "WORKGROUP" };

  test("builds the expected argv and authfile, avoiding name collisions", async () => {
    const { calls, runner } = runnerStub((argv) => {
      const cmd = argv[argv.indexOf("-c") + 1]!;
      if (cmd === 'ls "inbox/2026/scan.pdf"') return { code: 0, stdout: "  scan.pdf   A   10  Mon Oct 26 01:14:00 2026\n" };
      if (cmd.includes("ls ")) return { code: 1, stdout: "NT_STATUS_NO_SUCH_FILE listing \\inbox\\2026\\scan-2.pdf\n" };
      return { code: 0, stdout: "putting file ...\n" };
    });
    const d = createSmbDestination(runner);
    const files = outFiles(["scan.pdf"]);
    await d.send(files, d.parse(config), meta);
    expect(calls[0]!.argv.slice(0, 4)).toEqual(["smbclient", "//nas.example/scans", "-A", calls[0]!.argv[3]!]);
    expect(calls[0]!.authfile).toBe("username = user\npassword = pw\ndomain = WORKGROUP\n");
    const put = calls.at(-1)!.argv;
    expect(put[put.indexOf("-c") + 1]).toMatch(/^put "[^"]*\/upload-1" "inbox\/2026\/scan-2\.pdf"$/);
  });

  test("two deliveries of the same name at once get different names", async () => {
    const present = new Set<string>();
    const runner: CommandRunner = async (argv) => {
      const cmd = argv[argv.indexOf("-c") + 1]!;
      await Bun.sleep(5); // let the other delivery run in between
      const ls = /^ls "(.+)"$/.exec(cmd);
      if (ls) return present.has(ls[1]!) ? { code: 0, stdout: "  x  A  1\n", stderr: "" } : { code: 1, stdout: "NT_STATUS_NO_SUCH_FILE\n", stderr: "" };
      const put = /^put "[^"]+" "(.+)"$/.exec(cmd);
      if (put) present.add(put[1]!);
      return { code: 0, stdout: "", stderr: "" };
    };
    const d = createSmbDestination(runner);
    const c = d.parse(config);
    await Promise.all([d.send(outFiles(["scan.pdf"]), c, meta), d.send(outFiles(["scan.pdf"]), c, meta)]);
    expect([...present].sort()).toEqual(["inbox/2026/scan-2.pdf", "inbox/2026/scan.pdf"]);
  });

  test("maps NT_STATUS_LOGON_FAILURE to a DeliveryError", async () => {
    const { runner } = runnerStub(() => ({ code: 1, stdout: "", stderr: "session setup failed: NT_STATUS_LOGON_FAILURE\n" }));
    const d = createSmbDestination(runner);
    const err = await d.test(d.parse(config)).catch((e) => e);
    expect(err).toBeInstanceOf(DeliveryError);
    expect(err.message).toBe("SMB: NT_STATUS_LOGON_FAILURE");
  });

  test("authfile is removed after use", async () => {
    let authPath = "";
    const d = createSmbDestination(async (argv) => {
      authPath = argv[argv.indexOf("-A") + 1]!;
      return { code: 0, stdout: "", stderr: "" };
    });
    await d.test(d.parse(config));
    expect(await Bun.file(authPath).exists()).toBe(false);
  });

  test("file names cannot inject smbclient commands", async () => {
    const uploads: string[] = [];
    const { calls, runner } = runnerStub((argv) => {
      const cmd = argv[argv.indexOf("-c") + 1]!;
      if (cmd.startsWith("ls ")) return { code: 1, stdout: "NT_STATUS_NO_SUCH_FILE\n" };
      const local = cmd.match(/^put "([^"]*)"/)?.[1];
      if (local) uploads.push(readFileSync(local, "utf8"));
      return { code: 0, stdout: "" };
    });
    const d = createSmbDestination(runner);
    const files = outFiles(["Bill; ACME; deltree Archive; x.pdf", "50% [draft]'s.pdf"]);
    const res = await d.send(files, d.parse(config), meta);
    const puts = calls.map((c) => c.argv[c.argv.indexOf("-c") + 1]!).filter((cmd) => !cmd.startsWith("ls "));
    expect(puts).toHaveLength(2);
    for (const cmd of puts) {
      expect(cmd.match(/\bput\b/g)).toHaveLength(1);
      // "deltree" may stay in the file name; it must never become a command of its own.
      expect(cmd.split(";").filter((part) => /^\s*deltree\b/.test(part))).toEqual([]);
      expect(cmd).not.toMatch(/[;%[\]']/);
    }
    expect(uploads).toEqual(["content of Bill; ACME; deltree Archive; x.pdf", "content of 50% [draft]'s.pdf"]);
    expect(res.ref).toBe("Bill_ ACME_ deltree Archive_ x.pdf, 50_ _draft__s.pdf");
  });

  test("rejects paths that could inject smbclient commands", () => {
    const d = createSmbDestination(async () => ({ code: 0, stdout: "", stderr: "" }));
    expect(() => d.parse({ ...config, path: 'x"; rm *' })).toThrow(ValidationError);
    expect(() => d.parse({ ...config, path: "a;b" })).toThrow(ValidationError);
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
  test.skipIf(!process.env.TEST_SMB_URL)("smb roundtrip", async () => {
    // TEST_SMB_URL=smb://user:pass@server/share/path
    const u = new URL(process.env.TEST_SMB_URL!);
    const [, share, ...rest] = u.pathname.split("/");
    const d = getDestination("smb");
    const c = d.parse({ server: u.hostname, share, path: rest.join("/"), username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) });
    await d.test(c);
    await d.send(outFiles(["webapp-test.txt"]), c, meta);
  });
  test.skipIf(!process.env.TEST_FTP_URL)("ftp roundtrip", async () => {
    const u = new URL(process.env.TEST_FTP_URL!);
    const d = getDestination("ftp");
    const c = d.parse({ host: u.hostname, port: Number(u.port || 21), path: u.pathname || "/", username: decodeURIComponent(u.username), password: decodeURIComponent(u.password), secure: false });
    await d.test(c);
    await d.send(outFiles(["webapp-test.txt"]), c, meta);
  });
});

test("every destination type is registered", () => {
  for (const t of ["download", "folder", "smb", "ftp", "paperless", "papra", "webhook"] as const) expect(getDestination(t).type).toBe(t);
  mkdirSync(tmpdir(), { recursive: true });
});
