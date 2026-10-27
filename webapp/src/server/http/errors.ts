import { HTTPException } from "hono/http-exception";
import { DeliveryError, ValidationError } from "../destinations/types";
import { logger } from "../log";
import { InvalidScan, JobNotFound, PrinterOff, ScannerBusy, ServiceUnreachable } from "../scanner-client";
import { SecretError } from "../secrets";
import { NotFound, StateError } from "../services/errors";

/** The `{ error: <code>, message }` answer every failure uses; JSON answers are never cached. */
export const fail = (status: number, error: string, message: string) =>
  Response.json({ error, message }, { status, headers: { "cache-control": "no-store" } });

const log = logger("api");

/** Maps domain errors to HTTP answers: `{ error: <code>, message }`. */
export function errorResponse(e: unknown): Response {
  // Hono's validators throw a 400 for a body they can't parse; other HTTP exceptions keep their own answer.
  if (e instanceof HTTPException) {
    if (e.status !== 400) return e.getResponse();
    return fail(400, "invalid", e.message === "Malformed JSON in request body" ? "Request body must be a JSON object" : e.message || "Bad request");
  }
  if (e instanceof ValidationError || e instanceof InvalidScan) return fail(400, "invalid", e.message);
  if (e instanceof NotFound || e instanceof JobNotFound) return fail(404, "not_found", e.message);
  if (e instanceof ScannerBusy) return fail(409, "busy", e.message);
  if (e instanceof StateError) return fail(409, "conflict", e.message);
  if (e instanceof SecretError) return fail(409, "needs_credentials", "Stored credentials can't be decrypted — re-enter credentials");
  if (e instanceof PrinterOff) return fail(503, "printer_off", e.message);
  if (e instanceof ServiceUnreachable) return fail(503, "service_unreachable", e.message);
  if (e instanceof DeliveryError) return fail(422, "test_failed", e.message);
  log.error(e);
  return fail(500, "internal", e instanceof Error ? e.message : String(e));
}
