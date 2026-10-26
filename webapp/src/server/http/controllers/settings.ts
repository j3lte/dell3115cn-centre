import { createRoute, z } from "@hono/zod-openapi";
import type { Services } from "../../services";
import { emptyJsonIsNoBody, errBody, forbidden, json, jsonBody, newRouter } from "../router";
import { SettingsViewSchema, WhiteCalibrationSchema } from "../schemas";

const invalid = { 400: errBody("Invalid request, or a value the settings rules refuse") };
const tags = ["Settings"];

const SourceSchema = z.enum(["flatbed", "adf"]);
const CalibrateBody = z.object({ source: SourceSchema }).openapi("CalibrateWhite");
const sourceParam = z.object({ source: SourceSchema.openapi({ param: { name: "source", in: "path" }, example: "flatbed" }) });
const view = (description: string) => jsonBody(SettingsViewSchema, description);

const get = createRoute({
  method: "get",
  path: "/api/settings",
  tags,
  summary: "The settings, as the Settings page shows them",
  responses: { 200: view("The settings") },
});

const update = createRoute({
  method: "put",
  path: "/api/settings",
  tags,
  summary: "Change settings; keys that are left out stay as they are, unknown keys are ignored",
  middleware: [emptyJsonIsNoBody],
  request: { body: { required: false, content: { "application/json": { schema: z.record(z.string(), z.unknown()).openapi("SettingsPatch") } } } },
  responses: { 200: view("The settings after the change"), ...invalid, ...forbidden, 404: errBody("No such profile") },
});

const regenerateKey = createRoute({
  method: "post",
  path: "/api/settings/mcp-key",
  tags,
  summary: "Generate a new MCP key; outstanding download links stop working",
  responses: { 200: view("The settings with the new key"), ...forbidden },
});

const calibrate = createRoute({
  method: "post",
  path: "/api/calibration/white",
  tags,
  summary: "Scan plain white paper and store the white-point gains for that source",
  request: { body: { required: true, content: { "application/json": { schema: CalibrateBody } } } },
  responses: {
    200: jsonBody(WhiteCalibrationSchema, "The stored calibration"),
    ...invalid,
    ...forbidden,
    409: errBody("The scanner is busy or the scan failed"),
    503: errBody("The printer is off or the scanner service is unreachable"),
  },
});

const clear = createRoute({
  method: "delete",
  path: "/api/calibration/white/{source}",
  tags,
  summary: "Remove the white-point calibration of one source",
  request: { params: sourceParam },
  responses: { 204: { description: "Removed" }, ...invalid, ...forbidden },
});

export function settingsController(s: Services) {
  const { settings, calibration } = s;
  return newRouter()
    .openapi(get, (c) => json(c, settings.view()))
    .openapi(update, (c) => {
      settings.update(c.req.valid("json") ?? {}, { allowMcp: true });
      return json(c, settings.view());
    })
    .openapi(regenerateKey, (c) => {
      settings.regenerateMcpKey();
      return json(c, settings.view());
    })
    .openapi(calibrate, async (c) => json(c, await calibration.calibrate(c.req.valid("json").source)))
    .openapi(clear, (c) => {
      calibration.clear(c.req.valid("param").source);
      return c.body(null, 204);
    });
}
