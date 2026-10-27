import { afterEach, expect, test } from "bun:test";
import { configureLog, logger, parseLogLevel } from "../src/server/log";
import { TEST_LOG_LEVEL } from "./quiet-log";

const T = new Date("2026-10-27T19:40:01.234Z");

function capture(level: "debug" | "info" | "warn" | "error" = "info") {
  const lines: string[] = [];
  configureLog({ level, sink: (l) => lines.push(l), clock: () => T });
  return lines;
}

afterEach(() => configureLog({ level: TEST_LOG_LEVEL, sink: (l) => process.stdout.write(`${l}\n`), clock: () => new Date() }));

test("one plain-text line: UTC timestamp, padded level, component, message", () => {
  const lines = capture();
  logger("scan").info("started", 3, { a: 1 });
  logger("scan").warn("slow");
  expect(lines).toEqual(["2026-10-27T19:40:01.234Z INFO  scan: started 3 { a: 1 }", "2026-10-27T19:40:01.234Z WARN  scan: slow"]);
});

test("lines under the level are dropped", () => {
  const lines = capture("warn");
  const log = logger("x");
  log.debug("d");
  log.info("i");
  log.warn("w");
  log.error("e");
  expect(lines.map((l) => l.split(" ")[1])).toEqual(["WARN", "ERROR"]);
});

test("debug shows with level debug", () => {
  const lines = capture("debug");
  logger("http").debug("GET /api/status 200 3ms");
  expect(lines).toEqual(["2026-10-27T19:40:01.234Z DEBUG http: GET /api/status 200 3ms"]);
});

test("an error carries its stack", () => {
  const lines = capture();
  const e = new Error("boom");
  logger("api").error("failed:", e);
  expect(lines[0]).toStartWith("2026-10-27T19:40:01.234Z ERROR api: failed: Error: boom\n");
  expect(lines[0]).toContain(e.stack!.split("\n")[1]!);
});

test("LOG_LEVEL: unset is info, case-insensitive, warning is warn, unknown throws", () => {
  expect(parseLogLevel(undefined)).toBe("info");
  expect(parseLogLevel("")).toBe("info");
  expect(parseLogLevel("DEBUG")).toBe("debug");
  expect(parseLogLevel("warning")).toBe("warn");
  expect(() => parseLogLevel("loud")).toThrow("LOG_LEVEL must be debug, info, warn or error: loud");
});
