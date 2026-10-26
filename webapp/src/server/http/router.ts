import { OpenAPIHono, type z } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler, TypedResponse } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { JSONParsed } from "hono/utils/types";
import { fail } from "./errors";
import { ErrorSchema } from "./schemas";

/**
 * A router for one controller (or the app). A request that fails its zod check answers
 * `400 { error: "invalid", message: "<path>: <message>" }` from the first issue (no prefix for the root).
 */
export function newRouter() {
  return new OpenAPIHono({
    defaultHook: (result) => {
      if (result.success) return;
      const issue = result.error.issues[0];
      const path = issue?.path.map(String).join(".") ?? "";
      const message = issue?.message ?? "Invalid request";
      return fail(400, "invalid", path ? `${path}: ${message}` : message);
    },
  });
}

type JsonResponse<T, S extends ContentfulStatusCode> = Response & TypedResponse<JSONParsed<T>, S, "json">;

const NO_STORE = { "cache-control": "no-store" };

/** A JSON answer that is never cached; typed like `c.json`, so routes keep their response types. */
export function json<T>(c: Context, body: T): JsonResponse<T, 200>;
export function json<T, S extends ContentfulStatusCode>(c: Context, body: T, status: S): JsonResponse<T, S>;
export function json(c: Context, body: unknown, status: ContentfulStatusCode = 200): Response {
  return c.json(body as never, status, NO_STORE);
}

/** A documented answer: `{ description, content: { "application/json": { schema } } }`. */
export const jsonBody = <S extends z.ZodType>(schema: S, description: string) => ({ description, content: { "application/json": { schema } } });

/**
 * For routes whose body is optional: a JSON request with an empty (or blank) body counts as no body, like `{}` did
 * before, instead of failing the JSON parse. A malformed body still reaches the validator and answers 400.
 */
export const emptyJsonIsNoBody: MiddlewareHandler = async (c, next) => {
  const raw = c.req.raw;
  if (/^application\/json\s*(;|$)/i.test(raw.headers.get("content-type") ?? "") && !(await raw.clone().text()).trim()) {
    const headers = new Headers(raw.headers);
    headers.delete("content-type");
    headers.delete("content-length");
    c.req.raw = new Request(raw.url, { method: raw.method, headers });
  }
  await next();
};

/** A documented error answer: `{ error, message }`. */
export const errBody = (description: string) => jsonBody(ErrorSchema, description);

/** The 403 every state-changing route can answer (see `crossSiteGuard`). */
export const forbidden = { 403: errBody("Cross-site request refused") };

/** A JSON request body, required unless said otherwise. */
export const jsonRequest = <S extends z.ZodType>(schema: S, required = true) => ({ required, content: { "application/json": { schema } } });
