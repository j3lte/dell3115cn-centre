import type { MiddlewareHandler } from "hono";
import { fail } from "./errors";

const stripDefaultPort = (host: string) => host.toLowerCase().replace(/:(80|443)$/, "");

/**
 * True unless the request carries an `Origin` from another site. The scheme is ignored (the app may sit behind an
 * HTTPS proxy); host and port must equal the request's `Host` (or the proxy's `X-Forwarded-Host`). No `Origin` (curl,
 * same-origin GET) is allowed.
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false; // "null" (sandboxed frames, file://) or garbage
  }
  if (!host) return false;
  const own = [req.headers.get("host") ?? new URL(req.url).host, ...(req.headers.get("x-forwarded-host")?.split(",") ?? [])];
  return own.some((h) => h.trim() && stripDefaultPort(h.trim()) === stripDefaultPort(host));
}

/**
 * Why a state-changing request must be refused, or null. Blocks cross-site requests: a foreign `Origin`, and bodies a
 * plain HTML form or no-CORS fetch can send (anything but application/json). A request without body and without
 * Content-Type is fine (DELETE, POST /api/connect, ...).
 */
function crossSiteReason(req: Request): string | null {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return null;
  if (!sameOrigin(req)) return "Cross-origin requests are not allowed";
  const type = req.headers.get("content-type");
  const hasBody = Number(req.headers.get("content-length") ?? 0) > 0 || req.headers.has("transfer-encoding");
  if ((type !== null || hasBody) && !/^application\/json\s*(;|$)/i.test(type ?? "")) return "Request body must be sent as application/json";
  return null;
}

/** Refuses cross-site writes with 403 `forbidden` before any route sees them. */
export const crossSiteGuard: MiddlewareHandler = async (c, next) => {
  const refused = crossSiteReason(c.req.raw);
  if (refused) return fail(403, "forbidden", refused);
  await next();
};
