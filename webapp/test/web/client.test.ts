import { afterEach, expect, test } from "bun:test";
import { createApp } from "../../src/server/http/app";
import { ApiError } from "../../src/web/lib/errors";
import { makeClient, unwrap, unwrapBlob } from "../../src/web/lib/client";
import { makeHarness, type Harness } from "../scan-harness";

let h: Harness;
afterEach(() => h?.close());

/** The typed client over the real app, without a network. */
async function setup() {
  h = await makeHarness();
  const app = createApp(h.services);
  return makeClient("http://app.local", (input, init) => Promise.resolve(app.fetch(new Request(input, init))));
}

/** The ApiError a promise rejects with. */
async function rejection(p: Promise<unknown>): Promise<ApiError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ApiError);
  return e as ApiError;
}

test("unwrap returns the input profiles", async () => {
  const client = await setup();
  const saved = h.input({ name: "Glass" });
  const profiles = await unwrap(client.api["input-profiles"].$get());
  expect(profiles.map((p) => p.name)).toContain("Glass");
  expect(profiles.find((p) => p.id === saved.id)?.dpi).toBe(150);
});

test("unwrap maps a JSON error", async () => {
  const client = await setup();
  const e = await rejection(unwrap(client.api.scans[":id"].$get({ param: { id: "nope" } })));
  expect(e.code).toBe("not_found");
  expect(e.status).toBe(404);
  expect(e.message).not.toBe("Request failed (404)");
});

test("unwrap maps a network failure", async () => {
  const client = makeClient("http://app.local", () => Promise.reject(new TypeError("Failed to fetch")));
  const e = await rejection(unwrap(client.api["input-profiles"].$get()));
  expect(e.message).toBe("Can't reach the scan app — check your network connection");
  expect(e.code).toBe("network");
  expect(e.status).toBe(0);
});

test("unwrap answers undefined for 204", async () => {
  const client = await setup();
  const { id } = h.input();
  expect(await unwrap(client.api["input-profiles"][":id"].$delete({ param: { id: String(id) } }))).toBeUndefined();
  expect(h.profiles.listInput().some((p) => p.id === id)).toBe(false);
});

test("unwrap maps a non-JSON error", async () => {
  const client = makeClient("http://app.local", () => Promise.resolve(new Response("x", { status: 502 })));
  const e = await rejection(unwrap(client.api["input-profiles"].$get()));
  expect(e.message).toBe("Request failed (502)");
  expect(e.code).toBe("unknown");
  expect(e.status).toBe(502);
});

test("unwrap answers a body that isn't JSON as a Blob", async () => {
  const png = new Uint8Array([137, 80, 78, 71]);
  const client = makeClient("http://app.local", () => Promise.resolve(new Response(png, { headers: { "content-type": "image/png" } })));
  const blob = (await unwrap(client.api.preview.$post())) as unknown as Blob;
  expect(blob).toBeInstanceOf(Blob);
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(png);
  const typed: Blob = await unwrapBlob(client.api.preview.$post());
  expect(new Uint8Array(await typed.arrayBuffer())).toEqual(png);
});

test("unwrapBlob maps errors like unwrap", async () => {
  const client = makeClient("http://app.local", () => Promise.resolve(Response.json({ error: "busy", message: "Scanner busy" }, { status: 409 })));
  const e = await rejection(unwrapBlob(client.api.preview.$post()));
  expect([e.message, e.code, e.status]).toEqual(["Scanner busy", "busy", 409]);
});

test("unwrap falls back to the status for a JSON error without a message or with a broken body", async () => {
  const answer = (body: string) =>
    makeClient("http://app.local", () => Promise.resolve(new Response(body, { status: 409, headers: { "content-type": "application/json" } })));
  const empty = await rejection(unwrap(answer('{"error":"busy","message":""}').api["input-profiles"].$get()));
  expect(empty.message).toBe("Request failed (409)");
  expect(empty.code).toBe("busy");
  const broken = await rejection(unwrap(answer("{").api["input-profiles"].$get()));
  expect(broken.message).toBe("Request failed (409)");
  expect(broken.code).toBe("unknown");
  expect(broken.status).toBe(409);
});
