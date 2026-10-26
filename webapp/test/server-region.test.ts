import { expect, test } from "bun:test";
import { GLASS_MM, pageRectToGlass, unrotateRect } from "../src/server/pipeline/region";
import { GLASS_MM as WEB_GLASS_MM } from "../src/web/helpers/region";

test("unrotateRect maps a rect back for 0/90/180/270", () => {
  const W = 100, H = 200;
  expect(unrotateRect([10, 20, 30, 40], W, H, 0)).toEqual([10, 20, 30, 40]);
  expect(unrotateRect([10, 20, 30, 40], W, H, 90)).toEqual([20, 60, 40, 30]);
  expect(unrotateRect([10, 20, 30, 40], W, H, 180)).toEqual([60, 140, 30, 40]);
  expect(unrotateRect([10, 20, 30, 40], W, H, 270)).toEqual([140, 10, 40, 30]);
});

test("pageRectToGlass adds the scan area offset and clamps to the glass", () => {
  const page = { widthPx: 1200, heightPx: 600, dpi: 300, rotation: 0 }; // 101.6 x 50.8 mm
  expect(pageRectToGlass([10, 10, 20, 20], page, [50, 60, 101.6, 50.8])).toEqual([60, 70, 20, 20]);
  const big = pageRectToGlass([0, 0, 500, 500], { ...page, widthPx: 5000, heightPx: 7000 }, null);
  expect(big[2]).toBeCloseTo(215.6);
  expect(big[3]).toBeCloseTo(296.8);
});

test("pageRectToGlass undoes a 90 degree turn of the stored page", () => {
  // Stored page 600 x 1200 px at 300 dpi = 50.8 x 101.6 mm, turned 90 degrees clockwise from the scan.
  const page = { widthPx: 600, heightPx: 1200, dpi: 300, rotation: 90 };
  expect(pageRectToGlass([10, 20, 30, 40], page, null)).toEqual([20, 10.8, 40, 30]);
});

test("pageRectToGlass rejects an empty result", () => {
  const page = { widthPx: 1200, heightPx: 600, dpi: 300, rotation: 0 };
  expect(() => pageRectToGlass([10, 10, 0, 5], page, null)).toThrow();
  expect(() => pageRectToGlass([300, 400, 5, 5], page, [0, 0, 101.6, 50.8])).toThrow();
});

test("server and web agree on the glass size", () => {
  expect(GLASS_MM).toEqual([WEB_GLASS_MM.w, WEB_GLASS_MM.h]);
});
