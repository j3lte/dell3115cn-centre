/** "smb" is retired (see `Destination.retired`). */
export type DestinationType = "download" | "folder" | "sftp" | "ftp" | "paperless" | "papra" | "webhook" | "smb";

export const DESTINATION_TYPES: DestinationType[] = ["download", "folder", "sftp", "ftp", "paperless", "papra", "webhook", "smb"];

/** Config fields that hold credentials: encrypted at rest, never sent to the UI in full. */
export const SECRET_FIELDS: Record<DestinationType, string[]> = {
  download: [],
  folder: [],
  sftp: ["password", "privateKey", "passphrase"],
  ftp: ["password"],
  paperless: ["token"],
  papra: ["apiKey"],
  webhook: ["headerValue"],
  smb: ["password"],
};

/** What the UI gets instead of a stored secret. Sending it back on save keeps the stored value. */
export const SECRET_MASK = "••••";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Delivery failed; `message` is shown to the user as is. */
export class DeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryError";
  }
}

export type SendMeta = { scanId: string; title: string };

export type DeliveryFile = { name: string; path: string; mime: string };

export interface Destination<C> {
  type: DestinationType;
  /** Set on a destination that is no longer offered: its profiles still load, but every use refuses with this message. */
  retired?: string;
  /** Validates an untrusted config (UI form); throws ValidationError. */
  parse(config: unknown): C;
  /** Checks the settings work; throws DeliveryError. */
  test(c: C): Promise<void>;
  send(files: DeliveryFile[], c: C, meta: SendMeta): Promise<{ ref?: string }>;
}

/** A destination that is no longer offered: parse refuses with ValidationError, test and send with DeliveryError. */
export function retiredDestination(type: DestinationType, message: string): Destination<never> {
  return {
    type,
    retired: message,
    parse() {
      throw new ValidationError(message);
    },
    test: async () => {
      throw new DeliveryError(message);
    },
    send: async () => {
      throw new DeliveryError(message);
    },
  };
}

// ---- helpers shared by the destination modules ----

export function asObject(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new ValidationError("Destination settings must be an object");
  return config as Record<string, unknown>;
}

export function str(o: Record<string, unknown>, key: string, label: string, required = true): string {
  const v = o[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new ValidationError(`${label} is required`);
    return "";
  }
  if (typeof v !== "string") throw new ValidationError(`${label} must be text`);
  return v.trim();
}

export function httpUrl(o: Record<string, unknown>, key: string, label: string): string {
  const v = str(o, key, label);
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new ValidationError(`${label} is not a valid URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new ValidationError(`${label} must start with http:// or https://`);
  return v.replace(/\/+$/, "");
}

/** `host` and `port` of a config (FTP, SFTP); throws ValidationError. */
export function hostPort(o: Record<string, unknown>, defaultPort: number): { host: string; port: number } {
  const port = o.port === undefined || o.port === null || o.port === "" ? defaultPort : Number(o.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ValidationError("Port must be 1-65535");
  const host = str(o, "host", "Host");
  if (!/^[A-Za-z0-9.:_-]+$/.test(host)) throw new ValidationError("Host must be a host name or IP address");
  return { host, port };
}

const NETWORK_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"]);

/** A socket error that means the server can't be reached (for `cannotReach`). */
export function isNetworkError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && NETWORK_CODES.has(code);
}

/** Readable error for a network failure (fetch / sockets). */
export function cannotReach(host: string, e: unknown): DeliveryError {
  const err = e as { code?: unknown; message?: string; name?: string };
  const why = typeof err?.code === "string" && err.code ? err.code : err?.name === "TimeoutError" ? "timed out" : (err?.message ?? String(e));
  return new DeliveryError(`Cannot reach ${host}: ${why}`);
}

/** fetch() that turns network failures into DeliveryError("Cannot reach <host>: ...") and non-2xx into "<service> answered <status>". */
export async function fetchOk(service: string, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw cannotReach(new URL(url).hostname, e);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).trim().slice(0, 200);
    throw new DeliveryError(`${service} answered ${res.status} ${res.statusText}${body ? `: ${body}` : ""}`.trim());
  }
  return res;
}

export async function fileBlob(f: DeliveryFile): Promise<File> {
  return new File([await Bun.file(f.path).arrayBuffer()], f.name, { type: f.mime });
}

const queues = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` after every earlier call with the same key has finished. Destinations that look for a free file name and
 * then upload use it per target folder, so two deliveries at once can't both pick the same name.
 */
export function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  void tail.then(() => queues.get(key) === tail && queues.delete(key));
  return run;
}

/** "scan.pdf", "scan-2.pdf", "scan-3.pdf", ... */
export function candidateName(name: string, i: number): string {
  if (i === 1) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}-${i}${name.slice(dot)}` : `${name}-${i}`;
}
