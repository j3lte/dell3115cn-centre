import { Client } from "basic-ftp";
import { asObject, candidateName, cannotReach, DeliveryError, oneAtATime, str, ValidationError, type Destination } from "./types";

export type FtpConfig = { host: string; port: number; path: string; username: string; password: string; secure: boolean };

/** The part of basic-ftp's Client we use (injectable for tests). */
export interface FtpClientLike {
  access(o: { host: string; port: number; user: string; password: string; secure: boolean }): Promise<unknown>;
  ensureDir(path: string): Promise<void>;
  list(): Promise<{ name: string }[]>;
  uploadFrom(localPath: string, remoteName: string): Promise<unknown>;
  close(): void;
}

const NETWORK_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"]);

function ftpError(host: string, e: unknown): DeliveryError {
  if (e instanceof DeliveryError) return e;
  const code = (e as { code?: unknown }).code;
  if (typeof code === "string" && NETWORK_CODES.has(code)) return cannotReach(host, e);
  return new DeliveryError(`FTP: ${(e as Error).message ?? String(e)}`);
}

export function createFtpDestination(factory: () => FtpClientLike = () => new Client(30000)): Destination<FtpConfig> {
  async function withClient<T>(c: FtpConfig, fn: (client: FtpClientLike) => Promise<T>): Promise<T> {
    const client = factory();
    try {
      await client.access({ host: c.host, port: c.port, user: c.username, password: c.password, secure: c.secure });
      await client.ensureDir(c.path || "/");
      return await fn(client);
    } catch (e) {
      throw ftpError(c.host, e);
    } finally {
      client.close();
    }
  }

  return {
    type: "ftp",
    parse(config) {
      const o = asObject(config);
      const port = o.port === undefined || o.port === null || o.port === "" ? 21 : Number(o.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ValidationError("Port must be 1-65535");
      const host = str(o, "host", "Host");
      if (!/^[A-Za-z0-9.:_-]+$/.test(host)) throw new ValidationError("Host must be a host name or IP address");
      return {
        host,
        port,
        path: str(o, "path", "Path", false) || "/",
        username: str(o, "username", "User name", false) || "anonymous",
        password: typeof o.password === "string" ? o.password : "",
        secure: o.secure === true || o.secure === "true",
      };
    },
    async test(c) {
      await withClient(c, async () => {});
    },
    async send(files, c) {
      return oneAtATime(`ftp://${c.host}:${c.port}${c.path}`, async () => {
        return withClient(c, async (client) => {
          const existing = new Set((await client.list()).map((e) => e.name));
          const written: string[] = [];
          for (const f of files) {
            let name = f.name;
            for (let i = 2; existing.has(name); i++) name = candidateName(f.name, i);
            await client.uploadFrom(f.path, name);
            existing.add(name);
            written.push(name);
          }
          return { ref: written.join(", ") };
        });
      });
    },
  };
}

export const ftp = createFtpDestination();
