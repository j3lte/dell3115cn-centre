import { Client } from "basic-ftp";
import { asObject, candidateName, cannotReach, DeliveryError, hostPort, isNetworkError, oneAtATime, str, type Destination } from "./types";

export type FtpConfig = { host: string; port: number; path: string; username: string; password: string; secure: boolean };

/** The part of basic-ftp's Client we use (injectable for tests). */
export interface FtpClientLike {
  access(o: { host: string; port: number; user: string; password: string; secure: boolean }): Promise<unknown>;
  ensureDir(path: string): Promise<void>;
  list(): Promise<{ name: string }[]>;
  uploadFrom(localPath: string, remoteName: string): Promise<unknown>;
  close(): void;
}

function ftpError(host: string, e: unknown): DeliveryError {
  if (e instanceof DeliveryError) return e;
  if (isNetworkError(e)) return cannotReach(host, e);
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
      return {
        ...hostPort(o, 21),
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
