import { createHash, randomBytes } from "node:crypto";
import { posix } from "node:path";
import { Client, utils, type SFTPWrapper } from "ssh2";
import { asObject, candidateName, cannotReach, DeliveryError, oneAtATime, str, ValidationError, type Destination, type Learned } from "./types";

export type SftpConfig = {
  host: string;
  port: number;
  /** Remote folder; "." is the login folder. */
  path: string;
  username: string;
  password: string;
  privateKey: string;
  passphrase: string;
  /** Trusted host key ("SHA256:…"), stored on first use; "" trusts whatever key the server shows next. */
  hostKey: string;
};

export type SftpConnectOptions = {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  /** Called with the server's key fingerprint before logging in; false refuses the server. */
  verifyHostKey(fingerprint: string): boolean;
};

/** One SFTP connection (injectable for tests). Paths are remote; errors carry SFTP status codes (2 = no such file). */
export interface SftpClientLike {
  connect(o: SftpConnectOptions): Promise<void>;
  /** Throws when the path doesn't exist. */
  isDirectory(path: string): Promise<boolean>;
  list(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  /** Creates `remotePath` from the local file (null: an empty file); fails if it already exists. */
  put(localPath: string | null, remotePath: string): Promise<void>;
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
const WRITE_CHUNK = 32 * 1024;
const NETWORK_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"]);
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;

/** The real client: ssh2's SFTP subsystem. */
export class Ssh2SftpClient implements SftpClientLike {
  private readonly client = new Client();
  private sftp: SFTPWrapper | null = null;

  async connect(o: SftpConnectOptions): Promise<void> {
    const { verifyHostKey, ...rest } = o;
    await new Promise<void>((resolve, reject) => {
      // Keeps listening: a socket error after "ready" must not become an uncaught exception (the next call fails instead).
      this.client.once("ready", resolve).on("error", reject);
      try {
        this.client.connect({ ...rest, readyTimeout: READY_TIMEOUT, keepaliveInterval: KEEPALIVE_INTERVAL, hostVerifier: (key: Buffer) => verifyHostKey(fingerprint(key)) });
      } catch (e) {
        reject(e); // e.g. a private key ssh2 can't read
      }
    });
    this.sftp = await new Promise<SFTPWrapper>((resolve, reject) => this.client.sftp((e, s) => (e ? reject(e) : resolve(s.on("error", () => {})))));
  }

  private get s(): SFTPWrapper {
    if (!this.sftp) throw new Error("not connected");
    return this.sftp;
  }

  isDirectory(path: string): Promise<boolean> {
    return new Promise((resolve, reject) => this.s.stat(path, (e, st) => (e ? reject(e) : resolve(st.isDirectory()))));
  }

  list(path: string): Promise<string[]> {
    return new Promise((resolve, reject) => this.s.readdir(path, (e, list) => (e ? reject(e) : resolve(list.map((f) => f.filename)))));
  }

  exists(path: string): Promise<boolean> {
    return new Promise((resolve) => this.s.stat(path, (e) => resolve(!e)));
  }

  // Plain open/write/close: ssh2's write stream never reports "finish" under Bun.
  async put(localPath: string | null, remotePath: string): Promise<void> {
    const s = this.s;
    const handle = await new Promise<Buffer>((resolve, reject) => s.open(remotePath, "wx", { mode: 0o644 }, (e, h) => (e ? reject(e) : resolve(h))));
    try {
      const data = localPath === null ? Buffer.alloc(0) : Buffer.from(await Bun.file(localPath).arrayBuffer());
      for (let pos = 0; pos < data.length; pos += WRITE_CHUNK) {
        const len = Math.min(WRITE_CHUNK, data.length - pos);
        await new Promise<void>((resolve, reject) => s.write(handle, data, pos, len, pos, (e) => (e ? reject(e) : resolve())));
      }
    } finally {
      await new Promise<void>((resolve) => s.close(handle, () => resolve()));
    }
  }

  remove(path: string): Promise<void> {
    return new Promise((resolve, reject) => this.s.unlink(path, (e) => (e ? reject(e) : resolve())));
  }

  close(): void {
    this.client.end();
  }
}

function sftpError(host: string, username: string, e: unknown): DeliveryError {
  if (e instanceof DeliveryError) return e;
  const err = e as { code?: unknown; level?: unknown; message?: string };
  if (typeof err.code === "string" && NETWORK_CODES.has(err.code)) return cannotReach(host, e);
  if (err.level === "client-timeout") return cannotReach(host, { name: "TimeoutError" });
  if (err.level === "client-authentication") return new DeliveryError(`SFTP: login as ${username} failed (wrong password or key)`);
  return new DeliveryError(`SFTP: ${err.message ?? String(e)}`);
}

export function createSftpDestination(factory: () => SftpClientLike = () => new Ssh2SftpClient()): Destination<SftpConfig> {
  /** Connects with trust on first use: no stored key trusts the server's and reports it as learned. */
  async function withClient<T>(c: SftpConfig, fn: (client: SftpClientLike) => Promise<T>): Promise<{ result: T; learned?: Learned }> {
    const client = factory();
    let seen = "";
    try {
      try {
        await client.connect({
          host: c.host,
          port: c.port,
          username: c.username,
          password: c.password || undefined,
          privateKey: c.privateKey || undefined,
          passphrase: c.passphrase || undefined,
          verifyHostKey: (fp) => {
            seen = fp;
            return !c.hostKey || fp === c.hostKey;
          },
        });
      } catch (e) {
        if (c.hostKey && seen && seen !== c.hostKey)
          throw new DeliveryError(
            `Host key of ${c.host} changed (expected ${c.hostKey}, got ${seen}). If this is expected, clear the stored host key in the profile.`,
          );
        throw e;
      }
      const result = await fn(client);
      return !c.hostKey && seen ? { result, learned: { hostKey: seen } } : { result };
    } catch (e) {
      throw sftpError(c.host, c.username, e);
    } finally {
      client.close();
    }
  }

  async function checkFolder(client: SftpClientLike, path: string): Promise<void> {
    let dir: boolean;
    try {
      dir = await client.isDirectory(path);
    } catch (e) {
      if ((e as { code?: unknown }).code === NO_SUCH_FILE) throw new DeliveryError(`SFTP: folder ${path} does not exist`);
      throw e;
    }
    if (!dir) throw new DeliveryError(`SFTP: ${path} is not a folder`);
  }

  return {
    type: "sftp",
    parse(config) {
      const o = asObject(config);
      const port = o.port === undefined || o.port === null || o.port === "" ? 22 : Number(o.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ValidationError("Port must be 1-65535");
      const host = str(o, "host", "Host");
      if (!/^[A-Za-z0-9.:_-]+$/.test(host)) throw new ValidationError("Host must be a host name or IP address");
      const c: SftpConfig = {
        host,
        port,
        path: str(o, "path", "Path", false) || ".",
        username: str(o, "username", "User name"),
        password: typeof o.password === "string" ? o.password : "",
        privateKey: str(o, "privateKey", "Private key", false),
        passphrase: typeof o.passphrase === "string" ? o.passphrase : "",
        hostKey: str(o, "hostKey", "Host key", false),
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
      if (c.hostKey && !FINGERPRINT.test(c.hostKey)) throw new ValidationError("Host key must look like SHA256:… (or be empty)");
      return c;
    },
    async test(c) {
      const { learned } = await withClient(c, async (client) => {
        await checkFolder(client, c.path);
        const probe = posix.join(c.path, `.centre-test-${randomBytes(6).toString("hex")}`);
        try {
          await client.put(null, probe);
        } catch (e) {
          throw new DeliveryError(`SFTP: cannot write in ${c.path}: ${(e as Error).message ?? String(e)}`);
        }
        await client.remove(probe);
      });
      return learned;
    },
    async send(files, c) {
      return oneAtATime(`sftp://${c.host}:${c.port}/${c.path}`, async () => {
        const { result: written, learned } = await withClient(c, async (client) => {
          await checkFolder(client, c.path);
          const existing = new Set(await client.list(c.path));
          const written: string[] = [];
          for (const f of files) {
            let raced = 0;
            for (let i = 1; ; i++) {
              const name = candidateName(f.name, i);
              if (existing.has(name)) continue;
              const remote = posix.join(c.path, name);
              try {
                await client.put(f.path, remote);
              } catch (e) {
                // Created by someone else since the listing: try the next number (a few times, so an upload that
                // fails halfway and leaves its file behind doesn't loop).
                if (raced++ < 5 && (await client.exists(remote))) {
                  existing.add(name);
                  continue;
                }
                throw e;
              }
              existing.add(name);
              written.push(name);
              break;
            }
          }
          return written;
        });
        return learned ? { ref: written.join(", "), learned } : { ref: written.join(", ") };
      });
    },
  };
}

export const sftp = createSftpDestination();
