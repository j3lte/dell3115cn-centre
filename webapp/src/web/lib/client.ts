import { hc, type ClientResponse } from "hono/client";
import type { SuccessStatusCode } from "hono/utils/http-status";
import type { AppType } from "../../server/http/app";
import { ApiError } from "./errors";

/** What the client calls to send a request; `fetch` itself, or a stand-in. */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** The typed API client. `fetchImpl` replaces the browser's fetch (tests answer from the app itself). */
export const makeClient = (baseUrl: string, fetchImpl?: FetchLike) =>
  hc<AppType>(baseUrl, fetchImpl ? { fetch: fetchImpl as typeof fetch } : undefined);

export type Client = ReturnType<typeof makeClient>;

let current: Client | undefined;

/** The client for this page's origin, made on first use so modules that import it load without `location`. */
export const client: Client = {
  get api() {
    return (current ??= makeClient(location.origin)).api;
  },
};

type AnyResponse = ClientResponse<unknown, number, string>;

/** The body of the OK answers among a route's documented ones; `undefined` for 204. */
export type OkBody<R> = R extends ClientResponse<infer T, infer S, string> ? (S extends 204 ? undefined : S extends SuccessStatusCode ? T : never) : never;

/** The answer, once it is OK: a failed fetch, or an answer that isn't OK, rejects with an `ApiError` (see `unwrap`). */
async function settle(res: Promise<AnyResponse>): Promise<AnyResponse> {
  let r: AnyResponse;
  try {
    r = await res;
  } catch {
    throw new ApiError("Can't reach the scan app — check your network connection", "network", 0);
  }
  if (!r.ok) {
    if ((r.headers.get("content-type") ?? "").includes("json")) {
      const e = (await r.json().catch(() => ({}))) as { error?: string; message?: string };
      throw new ApiError(e.message || `Request failed (${r.status})`, e.error ?? "unknown", r.status);
    }
    throw new ApiError(`Request failed (${r.status})`, "unknown", r.status);
  }
  return r;
}

/**
 * The body of an API answer. A failed fetch, or an answer that isn't OK, rejects with an `ApiError`: the API's
 * `{ error, message }` when the answer is JSON, else `Request failed (<status>)`. 204 answers `undefined`; a body that
 * isn't JSON comes back as a `Blob`.
 */
export async function unwrap<R extends AnyResponse>(res: Promise<R>): Promise<OkBody<R>> {
  type T = OkBody<R>;
  const r = await settle(res);
  if (r.status === 204) return undefined as T;
  return ((r.headers.get("content-type") ?? "").includes("json") ? r.json() : r.blob()) as Promise<T>;
}

/** The body of a binary answer (an image), with the errors of `unwrap`. */
export async function unwrapBlob(res: Promise<AnyResponse>): Promise<Blob> {
  return (await settle(res)).blob();
}
