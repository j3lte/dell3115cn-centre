import type { Context } from "hono";
import type { Services } from "../services";
import { analyseController } from "./controllers/analyse";
import { filesController } from "./controllers/files";
import { profilesController } from "./controllers/profiles";
import { scansController } from "./controllers/scans";
import { settingsController } from "./controllers/settings";
import { systemController } from "./controllers/system";
import { docsPage, scalarScript } from "./docs";
import { errorResponse, fail } from "./errors";
import { crossSiteGuard } from "./guard";
import { newRouter } from "./router";

/** `/api/scans/:id` → a regex where a parameter is one path segment. */
const pathPattern = (path: string) => new RegExp(`^${path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\/:[^/]+/g, "/[^/]+")}$`);

/**
 * The HTTP API: cross-site guard first, then the controllers, the OpenAPI description and its reference page, then
 * the not-found handler. The returned instance is the chained one, so `AppType` carries every controller's route types.
 */
export function createApp(services: Services) {
  const app = newRouter();
  app.use("/api/*", crossSiteGuard);
  app.onError((e) => errorResponse(e));

  const routed = app
    .route("/", systemController(services))
    .route("/", profilesController(services)).route("/", scansController(services))
    .route("/", filesController(services))
    .route("/", settingsController(services))
    .route("/", analyseController(services));

  routed.use("/api/openapi.json", async (c, next) => {
    await next();
    c.header("cache-control", "no-store");
  });
  routed.doc31("/api/openapi.json", { openapi: "3.1.0", info: { title: "Dell 3115cn Centre API", version: "1.0.0" } });
  routed.get("/api/docs", docsPage);
  routed.get("/api/docs/scalar.js", scalarScript);

  // Built on the first request, when every route is registered; "ALL" entries are the guard.
  let patterns: RegExp[] | undefined;
  /** 405 when a route of another method takes this path, else null. */
  const wrongMethod = (c: Context) => {
    patterns ??= routed.routes.filter((r) => r.method !== "ALL").map((r) => pathPattern(r.path));
    const path = new URL(c.req.url).pathname;
    return patterns.some((re) => re.test(path)) ? fail(405, "method_not_allowed", `${c.req.method} not allowed`) : null;
  };

  routed.notFound((c) => wrongMethod(c) ?? fail(404, "not_found", `No route for ${new URL(c.req.url).pathname}`));
  return routed;
}

export type AppType = ReturnType<typeof createApp>;
