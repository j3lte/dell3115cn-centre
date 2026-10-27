import { afterEach, expect, test } from "bun:test";
import { configureLog, logger, logs, parseLogLevel, type LogLevel } from "../src/server/log";

let restore = () => {};
afterEach(() => restore());

/** Every line as written, timestamp included. */
function capture(level: LogLevel = "info") {
  const lines: string[] = [];
  restore = configureLog({ level, sink: (l) => lines.push(l) });
  return lines;
}

test("one plain-text line: UTC timestamp, padded level, component, message", () => {
  const lines = capture();
  logger("scan").info("started", 3, { a: 1 });
  logger("scan").warn("slow");
  expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z INFO  scan: started 3 \{ a: 1 \}$/);
  expect(lines[1]).toEndWith("Z WARN  scan: slow");
});

test("lines under the level are dropped", () => {
  const lines = capture("warn");
  const log = logger("x");
  log.debug("d");
  log.info("i");
  log.warn("w");
  log.error("e");
  expect(lines.map((l) => l.split(" ")[1])).toEqual(["WARN", "ERROR"]);
  expect([logs("info"), logs("warn")]).toEqual([false, true]);
});

test("debug shows with level debug", () => {
  const lines = capture("debug");
  logger("http").debug("GET /api/status 200 3ms");
  expect(lines[0]).toEndWith("Z DEBUG http: GET /api/status 200 3ms");
});

test("an error carries its stack, every line with the same prefix", () => {
  const lines = capture();
  const e = new Error("boom");
  logger("api").error("failed:", e);
  expect(lines.length).toBe(e.stack!.split("\n").length);
  expect(lines[0]).toEndWith("Z ERROR api: failed: Error: boom");
  const prefix = lines[0]!.slice(0, lines[0]!.indexOf("failed:"));
  expect(lines.every((l) => l.startsWith(prefix))).toBe(true);
  expect(lines[1]).toBe(prefix + e.stack!.split("\n")[1]);
});

test("LOG_LEVEL: unset is info, case-insensitive, warning is warn, unknown throws", () => {
  expect(parseLogLevel(undefined)).toBe("info");
  expect(parseLogLevel("")).toBe("info");
  expect(parseLogLevel("DEBUG")).toBe("debug");
  expect(parseLogLevel("warning")).toBe("warn");
  expect(() => parseLogLevel("loud")).toThrow("LOG_LEVEL must be debug, info, warn or error: loud");
});
