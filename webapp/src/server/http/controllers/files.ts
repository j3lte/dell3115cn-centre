import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { contentDisposition, decodePath } from "../../downloads";
import type { Services } from "../../services";
import { NotFound } from "../../services/errors";
import { errBody, newRouter } from "../router";

const tags = ["Files"];

const binary = z.string().openapi({ format: "binary" });
const file = (mime: string, description: string) => ({ description, content: { [mime]: { schema: binary } } });

/** Whole numbers, also negative ones (the service answers those with 404), as in the old router. */
const IntParam = (name: string) =>
  z
    .string()
    .regex(/^-?\d+$/, "must be a whole number")
    .transform(Number)
    .pipe(z.int())
    .openapi({ param: { name, in: "path" }, example: "1" });

const pageParams = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" }, example: "7f3c1d2e" }),
  n: IntParam("n"),
});
const fileParams = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" }, example: "7f3c1d2e" }),
  d: IntParam("d"),
  name: z.string().openapi({ param: { name: "name", in: "path" }, example: "scan.pdf" }),
});
const invalid = { 400: errBody("A path value is not a whole number") };

const thumb = createRoute({
  method: "get",
  path: "/api/scans/{id}/pages/{n}/thumb",
  tags,
  summary: "A page thumbnail",
  request: { params: pageParams },
  responses: { 200: file("image/jpeg", "The thumbnail"), ...invalid, 404: errBody("No such thumbnail") },
});

const view = createRoute({
  method: "get",
  path: "/api/scans/{id}/pages/{n}/view",
  tags,
  summary: "A page at viewing size, with its filter applied",
  request: { params: pageParams },
  responses: { 200: file("image/jpeg", "The page view"), ...invalid, 404: errBody("No such page") },
});

const delivered = createRoute({
  method: "get",
  path: "/api/scans/{id}/deliveries/{d}/files/{name}",
  tags,
  summary: "A file a delivery stored, as a download",
  request: { params: fileParams },
  responses: { 200: file("application/octet-stream", "The file, with its own MIME type"), ...invalid, 404: errBody("No such file") },
});

const preview = createRoute({
  method: "post",
  path: "/api/preview",
  tags,
  summary: "A quick 75 dpi colour preview of the whole glass; not stored",
  responses: {
    200: file("image/png", "The preview"),
    403: errBody("Cross-site request refused"),
    409: errBody("The scanner is busy or the scan failed"),
    503: errBody("The printer is off or the scanner service is unreachable"),
  },
});

/** A file from disk with its length, so clients can show progress. */
const sendFile = (c: Context, path: string, headers: Record<string, string>) => {
  const f = Bun.file(path);
  return c.body(f.stream(), 200, { ...headers, "content-length": String(f.size), "cache-control": "no-cache" });
};

export function filesController(s: Services) {
  const { scans } = s;
  return newRouter()
    .openapi(thumb, (c) => {
      const { id, n } = c.req.valid("param");
      const path = scans.thumbPath(id, n);
      if (!path) throw new NotFound("Thumbnail not found");
      return sendFile(c, path, { "content-type": "image/jpeg" });
    })
    .openapi(view, async (c) => {
      const { id, n } = c.req.valid("param");
      const path = await scans.pageView(id, n);
      if (!path) throw new NotFound("Page not found");
      return sendFile(c, path, { "content-type": "image/jpeg" });
    })
    .openapi(delivered, (c) => {
      const { id, d } = c.req.valid("param");
      // Hono already decoded the param; decodePath wants the raw segment, decoded exactly once.
      const decoded = decodePath(new URL(c.req.url).pathname.split("/").pop()!);
      const f = decoded === null ? null : scans.deliveryFile(id, d, decoded);
      if (!f) throw new NotFound("File not found");
      return sendFile(c, f.path, { "content-type": f.mime, "content-disposition": contentDisposition(f.name) });
    })
    .openapi(preview, async (c) => {
      const png = await scans.preview();
      return c.body(png, 200, { "content-type": "image/png", "cache-control": "no-store" });
    });
}
