import { createRoute, z } from "@hono/zod-openapi";
import { ValidationError } from "../../destinations/types";
import type { Services } from "../../services";
import { NotFound } from "../../services/errors";
import { emptyJsonIsNoBody, errBody, forbidden, json, jsonBody, jsonRequest, newRouter } from "../router";
import { FilterSchema, IntField, ScanViewSchema } from "../schemas";

const invalid = { 400: errBody("Invalid request, or a value the scan rules refuse") };
const notFound = { 404: errBody("No such scan") };
const conflict = { 409: errBody("The scan is busy or in the wrong state") };
const tags = ["Scans"];

/** Scan ids are opaque strings. */
const params = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, example: "7f3c1d2e" }) });
const scanView = (description: string) => jsonBody(ScanViewSchema, description);

const StartBody = z
  .object({
    inputProfileId: IntField,
    outputProfileId: IntField,
    review: z.boolean().optional(),
    areaMm: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable().optional(),
  })
  .openapi("StartScan");
const SendBody = z.object({ outputProfileId: IntField.optional() }).openapi("SendScan");
const PagesBody = z
  .object({
    rotate: z.object({ n: IntField, degrees: IntField }).optional(),
    remove: IntField.optional(),
    order: z.array(IntField).optional(),
    filter: z.object({ n: IntField, filter: FilterSchema.nullable().optional() }).optional(),
  })
  .openapi("EditPages");
const ListQuery = z.object({
  limit: z
    .string()
    .optional()
    .transform((v) => {
      const n = v !== undefined && /^\d+$/.test(v.trim()) ? Number(v) : 0;
      return n >= 1 ? Math.min(n, 100) : 20;
    })
    .openapi({ description: "How many scans, 1..100 (more is capped at 100); anything else falls back to 20", example: "20" }),
  before: z.string().optional().openapi({ description: "A `createdAt` cursor: only older scans", example: "1790000000000" }),
});

const start = createRoute({
  method: "post",
  path: "/api/scans",
  tags,
  summary: "Start a scan",
  request: { body: jsonRequest(StartBody) },
  responses: {
    202: scanView("The scan, now scanning"),
    ...invalid,
    ...forbidden,
    404: errBody("No such input or output profile"),
    409: errBody("The scanner is busy"),
    503: errBody("The printer is off or the scanner service is unreachable"),
  },
});

const list = createRoute({
  method: "get",
  path: "/api/scans",
  tags,
  summary: "Scan history, newest first",
  request: { query: ListQuery },
  responses: { 200: jsonBody(z.array(ScanViewSchema), "The scans"), ...invalid },
});

const get = createRoute({
  method: "get",
  path: "/api/scans/{id}",
  tags,
  summary: "One scan",
  request: { params },
  responses: { 200: scanView("The scan"), ...notFound },
});

const remove = createRoute({
  method: "delete",
  path: "/api/scans/{id}",
  tags,
  summary: "Delete a scan and its files",
  request: { params },
  responses: { 204: { description: "Deleted" }, ...notFound, ...conflict, ...forbidden },
});

const more = createRoute({
  method: "post",
  path: "/api/scans/{id}/more",
  tags,
  summary: "Scan more pages into a scan in review",
  request: { params },
  responses: { 202: scanView("The scan, scanning again"), ...notFound, ...conflict, ...forbidden, 503: errBody("The printer is off or the scanner service is unreachable") },
});

const send = createRoute({
  method: "post",
  path: "/api/scans/{id}/send",
  tags,
  summary: "Deliver a scan; the body may name another output profile",
  middleware: [emptyJsonIsNoBody],
  request: { params, body: jsonRequest(SendBody, false) },
  responses: { 200: scanView("The scan after delivery"), ...invalid, ...notFound, ...conflict, ...forbidden },
});

const resend = createRoute({
  method: "post",
  path: "/api/scans/{id}/resend",
  tags,
  summary: "Deliver a scan again; without a body id the scan's own output profile is used",
  middleware: [emptyJsonIsNoBody],
  request: { params, body: jsonRequest(SendBody, false) },
  responses: { 200: scanView("The scan after delivery"), ...invalid, ...notFound, ...conflict, ...forbidden },
});

const cancel = createRoute({
  method: "post",
  path: "/api/scans/{id}/cancel",
  tags,
  summary: "Cancel a running scan",
  request: { params },
  responses: { 202: scanView("The scan, cancelled"), ...notFound, ...conflict, ...forbidden },
});

const editPages = createRoute({
  method: "patch",
  path: "/api/scans/{id}/pages",
  tags,
  summary: "Rotate, remove, reorder or filter pages; applied in that order, answers the last view",
  request: { params, body: jsonRequest(PagesBody) },
  responses: { 200: scanView("The scan after the edits"), ...invalid, ...notFound, ...conflict, ...forbidden },
});

const setFilter = createRoute({
  method: "put",
  path: "/api/scans/{id}/filter",
  tags,
  summary: "Set the filter for the whole scan",
  request: { params, body: jsonRequest(FilterSchema) },
  responses: { 200: scanView("The scan with its new filter"), ...invalid, ...notFound, ...conflict, ...forbidden },
});

export function scansController(s: Services) {
  const { scans } = s;
  const router = newRouter();
  // An unknown scan is a 404 whatever the body says; these routes would otherwise answer a bad body with a 400 first.
  for (const route of [editPages, setFilter, send, resend])
    router.use(route.path.replace(/\{(\w+)\}/g, ":$1"), async (c, next) => {
      // Another method falls through to the 405.
      if (c.req.method === route.method.toUpperCase()) scans.requireScan(c.req.param("id")!);
      await next();
    });
  return router
    .openapi(start, async (c) => {
      const b = c.req.valid("json");
      return json(c, await scans.start(b.inputProfileId, b.outputProfileId, { review: b.review === true, areaMm: b.areaMm ?? undefined }), 202);
    })
    .openapi(list, (c) => {
      const { limit, before } = c.req.valid("query");
      let cursor: number | undefined;
      if (before) {
        cursor = Number(before.trim() === "" ? NaN : before);
        if (!Number.isInteger(cursor)) throw new ValidationError("before must be an integer");
      }
      return json(c, scans.list(limit, cursor));
    })
    .openapi(get, (c) => {
      const v = scans.get(c.req.valid("param").id);
      if (!v) throw new NotFound("Scan not found");
      return json(c, v);
    })
    .openapi(remove, async (c) => {
      await scans.remove(c.req.valid("param").id);
      return c.body(null, 204);
    })
    .openapi(more, async (c) => json(c, await scans.more(c.req.valid("param").id), 202))
    .openapi(send, async (c) => json(c, await scans.send(c.req.valid("param").id, c.req.valid("json")?.outputProfileId)))
    .openapi(resend, async (c) => {
      const { id } = c.req.valid("param");
      const v = scans.get(id);
      if (!v) throw new NotFound("Scan not found");
      const target = c.req.valid("json")?.outputProfileId ?? v.outputProfileId;
      if (target === null) throw new ValidationError("Choose an output profile");
      return json(c, await scans.resend(id, target));
    })
    .openapi(cancel, async (c) => json(c, await scans.cancel(c.req.valid("param").id), 202))
    .openapi(editPages, async (c) => {
      const { id } = c.req.valid("param");
      const b = c.req.valid("json");
      let v = scans.get(id);
      if (!v) throw new NotFound("Scan not found");
      if (b.rotate) v = await scans.rotate(id, b.rotate.n, b.rotate.degrees);
      if (b.remove !== undefined) v = await scans.removePage(id, b.remove);
      if (b.order) v = await scans.reorder(id, b.order);
      if (b.filter) v = await scans.setPageFilter(id, b.filter.n, b.filter.filter ?? null);
      return json(c, v);
    })
    .openapi(setFilter, async (c) => json(c, await scans.setScanFilter(c.req.valid("param").id, c.req.valid("json"))));
}
