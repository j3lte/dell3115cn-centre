import { createHash, randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { posix } from "node:path";
import { Client, utils, type SFTPWrapper } from "ssh2";
import { asObject, candidateName, cannotReach, DeliveryError, hostPort, isNetworkError, oneAtATime, str, ValidationError, type Destination } from "./types";

export type SftpConfig = {
  host: string;
  port: number;
  /** Remote folder; "." is the login folder. */
  path: string;
  username: string;
  password: string;
  privateKey: string;
  passphrase: string;
};

export type TrustedHostKey = { fingerprint: string; firstSeen: number };

/** Host keys trusted on first use, per server. */
export interface HostKeyStore {
  get(host: string, port: number): TrustedHostKey | null;
  /** Keeps a key that is already there. */
  set(host: string, port: number, fingerprint: string): void;
  forget(host: string, port: number): void;
}

/** One SFTP connection (injectable for tests). Paths are remote; errors carry SFTP status codes (2 = no such file). */
export interface SftpClientLike {
  /** `verifyHostKey` gets the server's key fingerprint before logging in; false refuses the server. */
  connect(o: {
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: string;
    passphrase?: string;
    verifyHostKey(fingerprint: string): boolean;
  }): Promise<void>;
  /** Throws when the path doesn't exist. */
  isDirectory(path: string): Promise<boolean>;
  list(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  /** Creates a file for writing; fails if it already exists. */
  create(path: string): Promise<Buffer>;
  write(handle: Buffer, data: Buffer, position: number): Promise<void>;
  closeFile(handle: Buffer): Promise<void>;
  remove(path: string): Promise<void>;
  close(): void;
}

/** OpenSSH's fingerprint of a raw host key: "SHA256:" + unpadded base64. */
export function fingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

const NO_SUCH_FILE = 2;
const READY_TIMEOUT = 30000;
/** Keepalives every 10 s (3 missed end the connection), so a server that goes away can't stall a delivery forever. */
const KEEPALIVE_INTERVAL = 10000;
export const WRITE_CHUNK = 256 * 1024;
/** Writes in flight at once: enough to keep a link with some latency busy. */
const WRITE_WINDOW = 8;

const call = <T>(fn: (cb: (e: Error | null | undefined, v: T) => void) => void) =>
  new Promise<T>((resolve, reject) => fn((e, v) => (e ? reject(e) : resolve(v))));

/** The real client: ssh2's SFTP subsystem (open/write/close: ssh2's write stream never reports "finish" under Bun). */
export class Ssh2SftpClient implements SftpClientLike {
  private readonly client = new Client();
  private sftp: SFTPWrapper | null = null;

  async connect({ verifyHostKey, ...o }: Parameters<SftpClientLike["connect"]>[0]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      // Keeps listening: a socket error after "ready" must not become an uncaught exception (the next call fails instead).
      this.client.once("ready", resolve).on("error", reject);
      try {
        this.client.connect({
          ...o,
          readyTimeout: READY_TIMEOUT,
          keepaliveInterval: KEEPALIVE_INTERVAL,
          hostVerifier: (key: Buffer) => verifyHostKey(fingerprint(key)),
        });
      } catch (e) {
        reject(e); // e.g. a private key ssh2 can't read
      }
    });
    this.sftp = (await call<SFTPWrapper>((cb) => this.client.sftp(cb))).on("error", () => {});
  }

  private get s(): SFTPWrapper {
    if (!this.sftp) throw new Error("not connected");
    return this.sftp;
  }

  async isDirectory(path: string): Promise<boolean> {
    return (await call<{ isDirectory(): boolean }>((cb) => this.s.stat(path, cb))).isDirectory();
  }

  async list(path: string): Promise<string[]> {
    return (await call<{ filename: string }[]>((cb) => this.s.readdir(path, cb))).map((f) => f.filename);
  }

  exists(path: string): Promise<boolean> {
    return new Promise((resolve) => this.s.stat(path, (e) => resolve(!e)));
  }

  create(path: string): Promise<Buffer> {
    return call<Buffer>((cb) => this.s.open(path, "wx", { mode: 0o644 }, cb));
  }

  write(handle: Buffer, data: Buffer, position: number): Promise<void> {
    return call<void>((cb) => this.s.write(handle, data, 0, data.length, position, (e) => cb(e, undefined)));
  }

  closeFile(handle: Buffer): Promise<void> {
    return call<void>((cb) => this.s.close(handle, (e) => cb(e, undefined)));
  }

  remove(path: string): Promise<void> {
    return call<void>((cb) => this.s.unlink(path, (e) => cb(e, undefined)));
  }

  close(): void {
    this.client.end();
  }
}

/** Creates `remote` (never over an existing file) from a local file in WRITE_CHUNK pieces, WRITE_WINDOW at a time. */
async function upload(client: SftpClientLike, localPath: string | null, remote: string): Promise<void> {
  const handle = await client.create(remote);
  try {
    if (localPath === null) return;
    const file = await open(localPath, "r");
    try {
      const size = (await file.stat()).size;
      const pending = new Set<Promise<void>>();
      let failed: { e: unknown } | null = null;
      for (let pos = 0; pos < size && !failed; pos += WRITE_CHUNK) {
        const buf = Buffer.allocUnsafe(Math.min(WRITE_CHUNK, size - pos));
        const { bytesRead } = await file.read(buf, 0, buf.length, pos);
        const w: Promise<void> = client
          .write(handle, buf.subarray(0, bytesRead), pos)
          .catch((e) => void (failed ??= { e }))
          .finally(() => pending.delete(w));
        pending.add(w);
        if (pending.size >= WRITE_WINDOW) await Promise.race(pending);
      }
      await Promise.all(pending);
      if (failed) throw (failed as { e: unknown }).e;
    } finally {
      await file.close();
    }
  } finally {
    await client.closeFile(handle);
  }
}

function sftpError(c: SftpConfig, e: unknown): DeliveryError {
  if (e instanceof DeliveryError) return e;
  const err = e as { level?: unknown; message?: string };
  if (isNetworkError(e)) return cannotReach(c.host, e);
  if (err.level === "client-timeout") return cannotReach(c.host, { name: "TimeoutError" });
  if (err.level === "client-authentication") return new DeliveryError(`SFTP: login as ${c.username} failed (wrong password or key)`);
  return new DeliveryError(`SFTP: ${err.message ?? String(e)}`);
}

export function createSftpDestination(hostKeys: HostKeyStore, factory: () => SftpClientLike = () => new Ssh2SftpClient()): Destination<SftpConfig> {
  /** Connects with trust on first use: the first server key seen for host:port is stored, a different one refused. */
  async function withClient<T>(c: SftpConfig, fn: (client: SftpClientLike) => Promise<T>): Promise<T> {
    const client = factory();
    const trusted = hostKeys.get(c.host, c.port)?.fingerprint;
    let seen = "";
    try {
      await client
        .connect({
          host: c.host,
          port: c.port,
          username: c.username,
          password: c.password || undefined,
          privateKey: c.privateKey || undefined,
          passphrase: c.passphrase || undefined,
          verifyHostKey: (fp) => {
            seen = fp;
            return !trusted || fp === trusted;
          },
        })
        .catch((e) => {
          if (!trusted || !seen || seen === trusted) throw e;
          throw new DeliveryError(
            `Host key of ${c.host} changed (expected ${trusted}, got ${seen}). If this is expected, use "Forget host key" in the output profile.`,
          );
        });
      if (!trusted && seen) hostKeys.set(c.host, c.port, seen);
      return await fn(client);
    } catch (e) {
      throw sftpError(c, e);
    } finally {
      client.close();
    }
  }

  async function checkFolder(client: SftpClientLike, path: string): Promise<void> {
    const dir = await client.isDirectory(path).catch((e) => {
      throw (e as { code?: unknown }).code === NO_SUCH_FILE ? new DeliveryError(`SFTP: folder ${path} does not exist`) : e;
    });
    if (!dir) throw new DeliveryError(`SFTP: ${path} is not a folder`);
  }

  return {
    type: "sftp",
    parse(config) {
      const o = asObject(config);
      const c: SftpConfig = {
        ...hostPort(o, 22),
        path: str(o, "path", "Path", false) || ".",
        username: str(o, "username", "User name"),
        password: typeof o.password === "string" ? o.password : "",
        privateKey: str(o, "privateKey", "Private key", false),
        passphrase: typeof o.passphrase === "string" ? o.passphrase : "",
      };
      if (!c.password && !c.privateKey) throw new ValidationError("Enter a password or a private key");
      if (c.privateKey) {
        if (!/^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]+-----END [A-Z0-9 ]*PRIVATE KEY-----$/.test(c.privateKey))
          throw new ValidationError("The private key must be the text of a key file (-----BEGIN … PRIVATE KEY-----)");
        const parsed = utils.parseKey(c.privateKey, c.passphrase || undefined);
        if (parsed instanceof Error) {
          if (/no passphrase given/i.test(parsed.message)) throw new ValidationError("The private key is encrypted: enter its passphrase");
          throw new ValidationError(`The private key can't be read: ${parsed.message}`);
        }
      }
      return c;
    },
    async test(c) {
      await withClient(c, async (client) => {
        await checkFolder(client, c.path);
        const probe = posix.join(c.path, `.centre-test-${randomBytes(6).toString("hex")}`);
        await upload(client, null, probe).catch((e) => {
          throw new DeliveryError(`SFTP: cannot write in ${c.path}: ${(e as Error).message ?? String(e)}`);
        });
        await client.remove(probe);
      });
    },
    async send(files, c) {
      return oneAtATime(`sftp://${c.host}:${c.port}/${c.path}`, () =>
        withClient(c, async (client) => {
          await checkFolder(client, c.path);
          const existing = new Set(await client.list(c.path));
          const written: string[] = [];
          for (const f of files) {
            let raced = 0;
            for (let i = 1; ; i++) {
              const name = candidateName(f.name, i);
              if (existing.has(name)) continue;
              existing.add(name);
              const remote = posix.join(c.path, name);
              try {
                await upload(client, f.path, remote);
              } catch (e) {
                // Taken by someone else since the listing: try the next number (a few times, so an upload that fails
                // halfway and leaves its file behind doesn't loop).
                if (raced++ < 5 && (await client.exists(remote))) continue;
                throw e;
              }
              written.push(name);
              break;
            }
          }
          return { ref: written.join(", ") };
        }),
      );
    },
  };
}
