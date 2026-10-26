import { expect, test } from "bun:test";
import { GLASS_MM, regionToMm } from "../src/web/helpers/region";

const preview = { width: 637, height: 877 }; // 75 dpi of the full glass

test("full preview maps to the full glass", () => {
  expect(regionToMm({ x: 0, y: 0, w: 637, h: 877 }, preview, GLASS_MM)).toEqual([0, 0, 215.6, 296.8]);
});

test("a region in the middle scales by the preview size", () => {
  const [x, y, w, h] = regionToMm({ x: 318.5, y: 438.5, w: 318.5, h: 438.5 }, preview, GLASS_MM);
  expect([x, y, w, h]).toEqual([107.8, 148.4, 107.8, 148.4]);
});

test("regions outside the preview are clamped to the glass", () => {
  expect(regionToMm({ x: -50, y: -20, w: 2000, h: 2000 }, preview, GLASS_MM)).toEqual([0, 0, 215.6, 296.8]);
  const [x, y, w, h] = regionToMm({ x: 500, y: 800, w: 400, h: 400 }, preview, GLASS_MM);
  expect(x + w).toBeCloseTo(215.6, 5);
  expect(y + h).toBeCloseTo(296.8, 5);
});

test("a rectangle dragged up-left is normalised", () => {
  expect(regionToMm({ x: 637, y: 877, w: -637, h: -877 }, preview, GLASS_MM)).toEqual([0, 0, 215.6, 296.8]);
});

test("minimum size is 10 x 10 mm and stays on the glass", () => {
  const [, , w, h] = regionToMm({ x: 100, y: 100, w: 2, h: 2 }, preview, GLASS_MM);
  expect([w, h]).toEqual([10, 10]);
  const [x, y, w2, h2] = regionToMm({ x: 636, y: 876, w: 1, h: 1 }, preview, GLASS_MM);
  expect([w2, h2]).toEqual([10, 10]);
  expect(x + w2).toBeLessThanOrEqual(215.6);
  expect(y + h2).toBeLessThanOrEqual(296.8);
});
