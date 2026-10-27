import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config";
import { openDb } from "./db";
import { downloadHandler, DownloadStore } from "./downloads";
import { createApp } from "./http/app";
import { sameOrigin } from "./http/guard";
import { deviceIccPath } from "./pipeline/icc";
import { LiveHub, type LiveSocket } from "./live";
import { configureLog, logger } from "./log";
import { mcpHandler } from "./mcp/http";
import { AnalyseClient } from "./analyse-client";
import { ScannerClient } from "./scanner-client";
import { resolveAppSecret, SecretBox } from "./secrets";
import { createServices } from "./services";
import { PrinterReader } from "./printer";
import indexHtml from "../web/index.html";

const config = loadConfig(process.env);
configureLog({ level: config.logLevel });
const log = logger("app");
if (!deviceIccPath())
  log.warn(
    "Scanner colour profile not found (set DEVICE_ICC or put dell3115cn.icm in assets/, see assets/README.md): colour scans will have a magenta cast.",
  );
mkdirSync(config.dataDir, { recursive: true });
const db = openDb(join(config.dataDir, "scan-webapp.sqlite"));

const secret = resolveAppSecret(config, config.dataDir);
if (secret.generated) {
  log.warn(
    [
      "APP_SECRET is not set. Destination credentials are encrypted with a generated secret,",
      `saved in ${join(config.dataDir, "app-secret")}. Set it in your compose file to keep credentials readable:`,
      `  APP_SECRET=${secret.secret}`,
    ].join("\n"),
  );
}

const client = new ScannerClient(config.serviceUrl);
const hub = new LiveHub(() => client.reconnectNow());
// One-time download links for assistants; switching MCP off or regenerating its key invalidates them all.
const downloads = new DownloadStore();
const services = createServices({
  db,
  box: new SecretBox(secret.secret),
  secret,
  client,
  hub,
  dataDir: config.dataDir,
  printer: new PrinterReader(config.printerUri),
  analyse: config.analyseUrl ? new AnalyseClient(config.analyseUrl) : undefined,
  onMcpChange: () => downloads.clear(),
});
const { settings, scans } = services;
// Analyses cut short by a restart fail, and their temporary scans go.
const interrupted = services.deda?.recover() ?? 0;
if (interrupted) logger("deda").info(`${interrupted} tracking-dot analysis(es) interrupted by the restart`);

hub.setSnapshot(() => [{ type: "status", status: client.status }, ...scans.liveScans().map((scan) => ({ type: "scan" as const, scan }))]);
client.onStatus((status) => hub.broadcast({ type: "status", status }));
// The printer's own Scan button starts a scan with the profiles from Settings → Printer button.
scans.listenToButton();
client.start();

const app = createApp(services);
// MCP endpoint for AI assistants: key generated and MCP enabled on first start (Settings → MCP).
const mcpOn = settings.ensureMcpKey().mcpEnabled;
const mcp = mcpHandler({ services, downloads, dataDir: config.dataDir });

const server = Bun.serve({
  port: config.port,
  // HMR and unminified bundles only when explicitly not in production.
  development: process.env.NODE_ENV !== "production" && { hmr: true },
  routes: {
    "/": indexHtml,
    "/api/*": (req) => app.fetch(req),
    "/files/*": downloadHandler(downloads),
    "/mcp": (req) => mcp(req),
    "/mcp/": (req) => mcp(req),
  },
  fetch(req, srv) {
    if (new URL(req.url).pathname === "/ws") {
      // Browsers don't apply CORS to WebSockets; another site's page could otherwise open the live socket.
      if (!sameOrigin(req)) return new Response("Cross-origin WebSocket not allowed", { status: 403 });
      if (srv.upgrade(req)) return;
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open: (ws) => hub.attach(ws as unknown as LiveSocket),
    close: (ws) => hub.detach(ws as unknown as LiveSocket),
    message: (ws, msg) => hub.message(ws as unknown as LiveSocket, String(msg)),
  },
});

// "listening" last: whoever waits for it has the lines before it.
log.info(`MCP endpoint: ${new URL("/mcp/", server.url)} (${mcpOn ? "enabled" : "disabled"})`);
log.info(`listening on ${server.url} (scanner service ${config.serviceUrl}, log level ${config.logLevel})`);

// Optional history cleanup ("delete after N days"), once at startup and then daily.
const runCleanup = () => {
  const days = settings.read().cleanupDays;
  if (days) {
    const n = scans.cleanup(days);
    if (n) logger("cleanup").info(`removed ${n} scan(s) older than ${days} days`);
  }
};
runCleanup();
setInterval(runCleanup, 24 * 60 * 60 * 1000);

// Expired download links and temporary assistant scans, every minute.
setInterval(() => {
  downloads.sweep();
  scans.sweepTemporary();
}, 60_000);

const shutdown = () => {
  client.stop();
  server.stop();
  db.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
