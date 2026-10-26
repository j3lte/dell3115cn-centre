import { createRoute, z } from "@hono/zod-openapi";
import type { Services } from "../../services";
import { errBody, forbidden, json, jsonBody, jsonRequest, newRouter } from "../router";
import {
  DestinationTestSchema,
  IdParam,
  InputProfileDraftSchema,
  InputProfileSchema,
  OutputProfileDraftSchema,
  OutputProfileSchema,
} from "../schemas";

const invalid = { 400: errBody("Invalid request, or a value the profile rules refuse") };
const notFound = { 404: errBody("No such profile") };
const params = z.object({ id: IdParam });
const ok = z.object({ ok: z.literal(true) });
const tags = ["Profiles"];

const listInput = createRoute({
  method: "get",
  path: "/api/input-profiles",
  tags,
  summary: "List input (scan) profiles",
  responses: { 200: jsonBody(z.array(InputProfileSchema), "Every input profile") },
});

const getInput = createRoute({
  method: "get",
  path: "/api/input-profiles/{id}",
  tags,
  summary: "One input profile",
  request: { params },
  responses: { 200: jsonBody(InputProfileSchema, "The profile"), ...invalid, ...notFound },
});

const createInput = createRoute({
  method: "post",
  path: "/api/input-profiles",
  tags,
  summary: "Create an input profile; an `id` in the body is ignored",
  request: { body: jsonRequest(InputProfileDraftSchema) },
  responses: { 201: jsonBody(InputProfileSchema, "The new profile"), ...invalid, ...forbidden },
});

const updateInput = createRoute({
  method: "put",
  path: "/api/input-profiles/{id}",
  tags,
  summary: "Replace an input profile",
  request: { params, body: jsonRequest(InputProfileDraftSchema) },
  responses: { 200: jsonBody(InputProfileSchema, "The updated profile"), ...invalid, ...notFound, ...forbidden },
});

const deleteInput = createRoute({
  method: "delete",
  path: "/api/input-profiles/{id}",
  tags,
  summary: "Delete an input profile",
  request: { params },
  responses: { 204: { description: "Deleted" }, ...invalid, ...forbidden },
});

const listOutput = createRoute({
  method: "get",
  path: "/api/output-profiles",
  tags,
  summary: "List output profiles; secrets are masked",
  responses: { 200: jsonBody(z.array(OutputProfileSchema), "Every output profile") },
});

const getOutput = createRoute({
  method: "get",
  path: "/api/output-profiles/{id}",
  tags,
  summary: "One output profile; secrets are masked",
  request: { params },
  responses: { 200: jsonBody(OutputProfileSchema, "The profile"), ...invalid, ...notFound },
});

const createOutput = createRoute({
  method: "post",
  path: "/api/output-profiles",
  tags,
  summary: "Create an output profile; an `id` in the body is ignored",
  request: { body: jsonRequest(OutputProfileDraftSchema) },
  responses: { 201: jsonBody(OutputProfileSchema, "The new profile, secrets masked"), ...invalid, ...forbidden },
});

const updateOutput = createRoute({
  method: "put",
  path: "/api/output-profiles/{id}",
  tags,
  summary: "Replace an output profile; a masked secret keeps the stored one",
  request: { params, body: jsonRequest(OutputProfileDraftSchema) },
  responses: { 200: jsonBody(OutputProfileSchema, "The updated profile, secrets masked"), ...invalid, ...notFound, ...forbidden },
});

const deleteOutput = createRoute({
  method: "delete",
  path: "/api/output-profiles/{id}",
  tags,
  summary: "Delete an output profile",
  request: { params },
  responses: { 204: { description: "Deleted" }, ...invalid, ...forbidden },
});

const testOutput = createRoute({
  method: "post",
  path: "/api/output-profiles/{id}/test",
  tags,
  summary: "Check that a saved profile's destination is reachable",
  request: { params },
  responses: {
    200: jsonBody(ok, "The destination answered"),
    ...invalid,
    409: errBody("Stored credentials can't be decrypted"),
    422: errBody("The destination refused the test"),
    ...forbidden,
  },
});

const addCommon = createRoute({
  method: "post",
  path: "/api/profiles/common",
  tags,
  summary: "Add the common profiles whose names are missing",
  responses: { 200: jsonBody(z.object({ input: z.number(), output: z.number() }), "How many profiles were added"), ...forbidden },
});

const testDestination = createRoute({
  method: "post",
  path: "/api/destinations/test",
  tags,
  summary: "Check a destination configuration before it is saved",
  request: { body: jsonRequest(DestinationTestSchema) },
  responses: {
    200: jsonBody(ok, "The destination answered"),
    ...invalid,
    409: errBody("Stored credentials can't be decrypted"),
    422: errBody("The destination refused the test"),
    ...forbidden,
  },
});

export function profilesController(s: Services) {
  const { profiles } = s;
  return newRouter()
    .openapi(listInput, (c) => json(c, profiles.listInput()))
    .openapi(getInput, (c) => json(c, profiles.getInput(c.req.valid("param").id)))
    .openapi(createInput, (c) => json(c, profiles.createInput(c.req.valid("json")), 201))
    .openapi(updateInput, (c) => json(c, profiles.updateInput(c.req.valid("param").id, c.req.valid("json"))))
    .openapi(deleteInput, (c) => {
      profiles.deleteInput(c.req.valid("param").id);
      return c.body(null, 204);
    })
    .openapi(listOutput, (c) => json(c, profiles.listOutput()))
    .openapi(getOutput, (c) => json(c, profiles.getOutput(c.req.valid("param").id)))
    .openapi(createOutput, (c) => {
      const { id: _ignored, ...draft } = c.req.valid("json");
      return json(c, profiles.saveOutput(draft, "targets"), 201);
    })
    .openapi(updateOutput, (c) => json(c, profiles.saveOutput({ ...c.req.valid("json"), id: c.req.valid("param").id }, "targets")))
    .openapi(deleteOutput, (c) => {
      profiles.deleteOutput(c.req.valid("param").id);
      return c.body(null, 204);
    })
    .openapi(testOutput, async (c) => {
      await profiles.testOutput(c.req.valid("param").id);
      return json(c, { ok: true as const });
    })
    .openapi(addCommon, (c) => json(c, profiles.addCommon()))
    .openapi(testDestination, async (c) => {
      const { type, config, id } = c.req.valid("json");
      await profiles.testDestination(type, config ?? {}, id ?? undefined, "targets");
      return json(c, { ok: true as const });
    });
}
