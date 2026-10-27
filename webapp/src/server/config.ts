export type Config = {
  serviceUrl: string;
  dataDir: string;
  port: number;
  appSecret?: string;
  /** CUPS queue to read supply levels from; null = off. */
  printerUri: string | null;
  /** Analyse service base URL (ANALYSE_ENDPOINT); null = Analyse section off. */
  analyseUrl: string | null;
};

/** The queue name cups/README.md installs, on the scanner service's host. */
const QUEUE = "Dell_MFP_Laser_3115cn";

export function loadConfig(env: Record<string, string | undefined>): Config {
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid PORT: ${env.PORT}`);
  const serviceUrl = (env.SERVICE_URL || "http://localhost:8765").replace(/\/+$/, "");
  const printer = env.PRINTER_URI?.trim();
  if (printer && printer !== "off" && !/^ipps?:\/\//.test(printer)) throw new Error(`PRINTER_URI must start with ipp:// or ipps://: ${printer}`);
  const analyse = env.ANALYSE_ENDPOINT?.trim();
  if (analyse && !/^https?:\/\/[^/]/.test(analyse)) throw new Error(`ANALYSE_ENDPOINT must start with http:// or https://: ${analyse}`);
  if (analyse && !URL.canParse(analyse)) throw new Error(`ANALYSE_ENDPOINT is not a valid URL: ${analyse}`);
  return {
    serviceUrl,
    dataDir: env.DATA_DIR || "/data",
    port,
    appSecret: env.APP_SECRET || undefined,
    printerUri: printer === "off" ? null : printer || `ipp://${new URL(serviceUrl).hostname}:631/printers/${QUEUE}`,
    analyseUrl: analyse ? analyse.replace(/\/+$/, "") : null,
  };
}
