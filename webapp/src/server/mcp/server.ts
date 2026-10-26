import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext, McpDeps } from "./common";
import { registerAdminTools } from "./tools-admin";
import { registerScanTools } from "./tools-scan";

export const INSTRUCTIONS = `Scanner: Dell MFP Laser 3115cn (flatbed and document feeder). Scans you make are temporary and are deleted after a
while unless you call store_scan; stored scans appear in the web app's History.
- If the user asks for a scan without naming a source, assume the document is on the flatbed and scan it without
  asking. Exception: if scanner_status reports paper in the feeder, first ask whether to scan the feeder instead.
- If the user asks for the feeder (or "the stack"), use source "adf".
- Choose settings to suit the request: documents gray 300 dpi; photos colour 300-600 dpi; fine detail: a region at
  600 dpi with sharpen "normal". 16-bit is colour only.
- For detail, look at the page (page_image) or a preview, then scan just that area (area_mm, or page_area for a region
  of an earlier flatbed page).
- To give the user a file, use get_download_links. Never send to an output profile unless the user asks for delivery.`;

/** A fresh MCP server with every tool; the endpoint builds one per request (stateless). */
export function buildMcpServer(deps: McpDeps, ctx: McpContext): McpServer {
  const server = new McpServer({ name: "dell3115cn-scanner", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  registerScanTools(server, deps, ctx);
  registerAdminTools(server, deps);
  return server;
}
