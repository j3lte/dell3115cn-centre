const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

/** LOG_LEVEL: debug, info (default), warn (or warning) or error, any case. */
export function parseLogLevel(v: string | undefined): LogLevel {
  const s = (v ?? "").trim().toLowerCase();
  if (!s) return "info";
  if (s === "warning") return "warn";
  if (s in LEVELS) return s as LogLevel;
  throw new Error(`LOG_LEVEL must be debug, info, warn or error: ${v}`);
}

let threshold: LogLevel = "info";
let sink: (line: string) => void = (line) => void process.stdout.write(`${line}\n`);
let clock = () => new Date();

/** Level, output and clock for every logger; tests swap the sink and clock. */
export function configureLog(o: { level?: LogLevel; sink?: (line: string) => void; clock?: () => Date }): void {
  if (o.level) threshold = o.level;
  if (o.sink) sink = o.sink;
  if (o.clock) clock = o.clock;
}

const part = (v: unknown) => (typeof v === "string" ? v : v instanceof Error ? (v.stack ?? `${v.name}: ${v.message}`) : Bun.inspect(v, { compact: true }));

function emit(level: LogLevel, component: string, parts: unknown[]): void {
  if (LEVELS[level] < LEVELS[threshold]) return;
  sink(`${clock().toISOString()} ${level.toUpperCase().padEnd(5)} ${component}: ${parts.map(part).join(" ")}`);
}

export type Logger = Record<LogLevel, (...parts: unknown[]) => void>;

/** Plain-text lines on stdout: `<UTC time> <LEVEL> <component>: <message>`. Never pass secrets or document content. */
export function logger(component: string): Logger {
  return {
    debug: (...p) => emit("debug", component, p),
    info: (...p) => emit("info", component, p),
    warn: (...p) => emit("warn", component, p),
    error: (...p) => emit("error", component, p),
  };
}
