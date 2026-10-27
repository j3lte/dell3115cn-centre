import { createRoute, z } from "@hono/zod-openapi";
import type { Services } from "../../services";
import { NotFound } from "../../services/errors";
import { fail } from "../errors";
import { errBody, forbidden, json, jsonBody, jsonRequest, newRouter } from "../router";
import { DedaCandidateSchema, DedaViewSchema, IntField } from "../schemas";

const tags = ["Analyse"];
const view = (description: string) => jsonBody(DedaViewSchema, description);
const notFound = { 404: errBody("No such analysis, or the Analyse section is not configured") };
const invalid = { 400: errBody("Invalid request, or a page that can't be analysed") };

const idParam = z.string().openapi({ param: { name: "id", in: "path" }, example: "0192f3a1" });
const params = z.object({ id: idParam });
/** overview, closeRaw, closeEnhanced or closeYellow; the service looks the name up in the entry's record, so anything else is a 404. */
const imageParams = z.object({ id: idParam, name: z.string().openapi({ param: { name: "name", in: "path" }, example: "overview" }) });

const FromHistoryBody = z.object({ scanId: z.string(), page: IntField }).openapi("DedaFromHistory");
const RenameBody = z.object({ name: z.string() }).openapi("DedaRename");

const list = createRoute({
  method: "get",
  path: "/api/analyse/deda",
  tags,
  summary: "Tracking-dot analyses, newest scan first",
  responses: { 200: jsonBody(z.object({ analyses: z.array(DedaViewSchema) }), "The analyses"), ...notFound },
});

const candidates = createRoute({
  method: "get",
  path: "/api/analyse/deda/candidates",
  tags,
  summary: "Stored scans with a colour page of at least 300 dpi, newest first (at most 50), listing only those pages",
  responses: { 200: jsonBody(z.object({ scans: z.array(DedaCandidateSchema) }), "The scans"), ...notFound },
});

const fromScan = createRoute({
  method: "post",
  path: "/api/analyse/deda/scan",
  tags,
  summary: "Scan a page on the flatbed and analyse it; the scan is temporary",
  responses: { 202: view("The analysis, now scanning"), ...forbidden, ...notFound },
});

const fromHistory = createRoute({
  method: "post",
  path: "/api/analyse/deda",
  tags,
  summary: "Analyse a stored History page (colour, at least 300 dpi)",
  request: { body: jsonRequest(FromHistoryBody) },
  responses: { 202: view("The analysis, now analysing"), ...invalid, ...forbidden, ...notFound },
});

const rename = createRoute({
  method: "patch",
  path: "/api/analyse/deda/{id}",
  tags,
  summary: "Rename an analysis",
  request: { params, body: jsonRequest(RenameBody) },
  responses: { 200: view("The renamed analysis"), ...invalid, ...forbidden, ...notFound },
});

const remove = createRoute({
  method: "delete",
  path: "/api/analyse/deda/{id}",
  tags,
  summary: "Delete an analysis and its images",
  request: { params },
  responses: { 204: { description: "Deleted" }, ...forbidden, ...notFound },
});

const clear = createRoute({
  method: "delete",
  path: "/api/analyse/deda",
  tags,
  summary: "Delete every analysis",
  responses: { 200: jsonBody(z.object({ removed: z.number() }), "How many were deleted"), ...forbidden, ...notFound },
});

const image = createRoute({
  method: "get",
  path: "/api/analyse/deda/{id}/images/{name}",
  tags,
  summary: "An image of an analysis",
  request: { params: imageParams },
  responses: { 200: { description: "The image", content: { "image/png": { schema: z.string().openapi({ format: "binary" }) } } }, ...notFound },
});

export function analyseController(s: Services) {
  const router = newRouter();
  // The whole section answers 404 when ANALYSE_ENDPOINT is unset, whatever the method or body.
  router.use("/api/analyse/*", async (c, next) => {
    if (!s.deda) return fail(404, "not_found", "Analyse is not configured");
    await next();
  });
  const deda = () => s.deda!;
  return router
    .openapi(list, (c) => json(c, { analyses: deda().list() }))
    .openapi(candidates, (c) => json(c, { scans: deda().candidates() }))
    .openapi(fromScan, (c) => json(c, deda().fromScan(), 202))
    .openapi(fromHistory, (c) => {
      const b = c.req.valid("json");
      return json(c, deda().fromHistory(b.scanId, b.page), 202);
    })
    .openapi(rename, (c) => json(c, deda().rename(c.req.valid("param").id, c.req.valid("json").name)))
    .openapi(remove, (c) => {
      deda().remove(c.req.valid("param").id);
      return c.body(null, 204);
    })
    .openapi(clear, (c) => json(c, { removed: deda().clear() }))
    .openapi(image, (c) => {
      const { id, name } = c.req.valid("param");
      const path = deda().imagePath(id, name);
      if (!path) throw new NotFound("Image not found");
      const f = Bun.file(path);
      return c.body(f.stream(), 200, { "content-type": "image/png", "content-length": String(f.size), "cache-control": "no-store" });
    });
}
