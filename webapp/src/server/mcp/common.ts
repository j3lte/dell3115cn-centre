import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DeliveryError, ValidationError } from "../destinations/types";
import type { DownloadStore } from "../downloads";
import { logger } from "../log";
import { InvalidScan, JobNotFound, PrinterOff, ScannerBusy, ServiceUnreachable } from "../scanner-client";
import { NotFound, StateError } from "../services/errors";
import type { Services } from "../services";
import { SecretError } from "../secrets";

export type McpDeps = {
  services: Services;
  downloads: DownloadStore;
  /** Exports for download links are written under `<dataDir>/exports/`. */
  dataDir: string;
};

/** Per request: the URL the client used to reach the app, for download links. */
export type McpContext = { baseUrl: string };

export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

const log = logger("mcp");

const USER_ERRORS = [DeliveryError, ValidationError, NotFound, StateError, ScannerBusy, PrinterOff, InvalidScan, JobNotFound, ServiceUnreachable, SecretError];

/** Runs a tool; problems the user can act on become tool errors (the assistant sees the message), bugs are logged. */
export async function run(fn: () => Promise<CallToolResult> | CallToolResult): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ScannerBusy) return errorResult("The scanner is busy with another scan; try again when it has finished");
    if (e instanceof PrinterOff) return errorResult("The printer is off or not connected");
    if (USER_ERRORS.some((cls) => e instanceof cls)) return errorResult((e as Error).message);
    log.error("tool failed:", e);
    return errorResult(`Internal error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
