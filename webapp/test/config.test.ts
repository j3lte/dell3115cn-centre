import { expect, test } from "bun:test";
import { loadConfig } from "../src/server/config";

test("defaults", () =>
  expect(loadConfig({})).toEqual({
    serviceUrl: "http://localhost:8765",
    dataDir: "/data",
    port: 8080,
    appSecret: undefined,
    printerUri: "ipp://localhost:631/printers/Dell_MFP_Laser_3115cn",
    analyseUrl: null,
  }));

test("env overrides", () =>
  expect(loadConfig({ SERVICE_URL: "http://scanner.example:9000/", DATA_DIR: "./data", PORT: "3000", APP_SECRET: "x" })).toEqual({
    serviceUrl: "http://scanner.example:9000",
    dataDir: "./data",
    port: 3000,
    appSecret: "x",
    printerUri: "ipp://scanner.example:631/printers/Dell_MFP_Laser_3115cn",
    analyseUrl: null,
  }));

test("empty APP_SECRET counts as unset", () => expect(loadConfig({ APP_SECRET: "" }).appSecret).toBeUndefined());

test("PRINTER_URI overrides the queue; off disables supply levels", () => {
  expect(loadConfig({ PRINTER_URI: "ipps://cups.example/printers/Q" }).printerUri).toBe("ipps://cups.example/printers/Q");
  expect(loadConfig({ PRINTER_URI: "off" }).printerUri).toBeNull();
  expect(() => loadConfig({ PRINTER_URI: "http://x/y" })).toThrow("PRINTER_URI");
});

test("ANALYSE_ENDPOINT: unset or empty is off, trailing slash trimmed, scheme checked", () => {
  expect(loadConfig({}).analyseUrl).toBeNull();
  expect(loadConfig({ ANALYSE_ENDPOINT: "  " }).analyseUrl).toBeNull();
  expect(loadConfig({ ANALYSE_ENDPOINT: "http://x:8770/" }).analyseUrl).toBe("http://x:8770");
  expect(() => loadConfig({ ANALYSE_ENDPOINT: "ftp://x" })).toThrow("ANALYSE_ENDPOINT must start with http:// or https://: ftp://x");
});
