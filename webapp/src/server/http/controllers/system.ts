import { createRoute, z } from "@hono/zod-openapi";
import type { Services } from "../../services";
import { errBody, forbidden, json, jsonBody, newRouter } from "../router";
import { PrinterViewSchema, ScannerStatusSchema } from "../schemas";

const status = createRoute({
  method: "get",
  path: "/api/status",
  tags: ["System"],
  summary: "Scanner service and printer connection state",
  responses: { 200: jsonBody(ScannerStatusSchema, "The scanner service's last known state") },
});

const printer = createRoute({
  method: "get",
  path: "/api/printer",
  tags: ["System"],
  summary: "Printer supplies, alerts and page count",
  responses: { 200: jsonBody(PrinterViewSchema, "What the CUPS queue knows about the printer") },
});

const refreshPrinter = createRoute({
  method: "post",
  path: "/api/printer/refresh",
  tags: ["System"],
  summary: "Ask the printer for a fresh state",
  description:
    "Sends CUPS a refresh job: the printer wakes up (warm-up noise, nothing is printed) and its state is read. With `ifStale=true` " +
    "(the web app does this when it is opened) only when the last read is older than the printerWakeHours setting.",
  request: {
    query: z.object({
      ifStale: z
        .enum(["true", "false"])
        .optional()
        .openapi({ description: "Only wake the printer when the last read is older than the printerWakeHours setting" }),
    }),
  },
  responses: { 200: jsonBody(PrinterViewSchema, "The printer's fresh state"), 400: errBody("ifStale is not true or false"), ...forbidden },
});

const connect = createRoute({
  method: "post",
  path: "/api/connect",
  tags: ["System"],
  summary: "Reconnect to the scanner service now",
  responses: { 202: jsonBody(z.object({ ok: z.literal(true) }), "Reconnecting"), ...forbidden },
});

export function systemController(s: Services) {
  return newRouter()
    .openapi(status, (c) => json(c, s.scanner.status))
    .openapi(printer, async (c) => json(c, await s.printer.get()))
    .openapi(refreshPrinter, async (c) =>
      json(c, await (c.req.valid("query").ifStale === "true" ? s.printer.refreshIfStale() : s.printer.refresh())),
    )
    .openapi(connect, (c) => {
      s.scanner.reconnectNow();
      return json(c, { ok: true as const }, 202);
    });
}
