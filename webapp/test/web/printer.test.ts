import { expect, test } from "bun:test";
import { headerAlert, navDot, supplyLabel } from "../../src/web/helpers/printer";
import { printerViewOf as view } from "./fixtures";

test("supplyLabel shortens toner names and shows unknown levels", () => {
  expect(supplyLabel({ name: "Cyan Toner", color: "cyan", type: "toner", level: 80, low: false })).toEqual({ name: "Cyan", value: "80%" });
  expect(supplyLabel({ name: "Belt Unit", color: "none", type: "transfer-unit", level: null, low: false })).toEqual({ name: "Belt unit", value: "?" });
  expect(supplyLabel({ name: "Fuser", color: "none", type: "fuser", level: 40, low: false })).toEqual({ name: "Fuser", value: "40%" });
});

test("headerAlert: only errors (printing blocked), all of them", () => {
  expect(headerAlert(view({ alerts: ["Front cover is open (077-300)"], severity: "error" }))).toBe("Printer: Front cover is open (077-300)");
  expect(headerAlert(view({ alerts: ["Tray 1 is out of paper"], severity: "warning" }))).toBeNull();
  expect(headerAlert(view({ alerts: ["A", "B"], severity: "error" }))).toBe("Printer: A; B");
  expect(headerAlert(null)).toBeNull();
});

test("navDot marks the Printer tab for errors and warnings", () => {
  expect(navDot(view({ alerts: ["x"], severity: "error" }))).toBe("error");
  expect(navDot(view({ alerts: ["Tray 1 is out of paper"], severity: "warning" }))).toBe("warning");
  expect(navDot(view({}))).toBeNull();
  expect(navDot(null)).toBeNull();
});
