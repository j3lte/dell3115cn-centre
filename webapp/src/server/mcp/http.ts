import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { sameOrigin } from "../http/guard";
import type { McpDeps } from "./common";
import { buildMcpServer } from "./server";

/** The URL the client used to reach the app (behind a proxy: X-Forwarded-*), without a trailing slash. */
export function baseUrlOf(req: Request): string {
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return host ? `${proto || url.protocol.replace(":", "")}://${host}` : url.origin;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * `/mcp` and `/mcp/`: stateless Streamable HTTP (JSON responses). Off → 404; a cross-site browser Origin → 403;
 * wrong or missing bearer key → 401. The Origin check stops pages on other sites, not DNS rebinding (the attacker's
 * Origin then matches the Host); the bearer key is what keeps uninvited clients out.
 */
export function mcpHandler(deps: McpDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    const s = deps.services.settings.read();
    if (!s.mcpEnabled || !s.mcpKey) return new Response("Not found", { status: 404 });
    if (req.headers.has("origin") && !sameOrigin(req)) return new Response("Cross-origin requests are not allowed", { status: 403 });
    const given = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
    if (!timingSafeEqual(given, s.mcpKey))
      return new Response("Unauthorized: send the MCP key from Settings as Authorization: Bearer <key>", {
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="scanner"' },
      });
    const server = buildMcpServer(deps, { baseUrl: baseUrlOf(req) });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      // JSON response mode: the response is complete when handleRequest returns.
      return await transport.handleRequest(req);
    } finally {
      void server.close();
    }
  };
}
