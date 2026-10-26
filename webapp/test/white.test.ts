import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import sharp from "sharp";
import { ValidationError } from "../src/server/destinations/types";
import { colorPnmToPng } from "../src/server/pipeline/icc";
import { magickAvailable } from "../src/server/pipeline/magick";
import { MAX_GAIN, measureWhite, whiteGains } from "../src/server/pipeline/white";
import { makeColourPnm } from "./fake-service";
import { tmpdir } from "./helpers";

/** sRGB 0-255 → linear 0-1 (IEC 61966-2-1). */
const lin = (v: number) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);

describe("whiteGains", () => {
  test("raises the weaker channels in linear light to the brightest one; never lowers", () => {
    const g = whiteGains([244, 254, 253]);
    expect(g[1]).toBe(1);
    expect(g[0]).toBeCloseTo(lin(254) / lin(244), 6);
    expect(g[2]).toBeCloseTo(lin(254) / lin(253), 6);
  });

  test("an already neutral white needs no correction", () => expect(whiteGains([250, 250, 250])).toEqual([1, 1, 1]));

  test("a patch that is not white (dark or strongly coloured) is refused", () => {
    expect(() => whiteGains([120, 125, 122])).toThrow(ValidationError);
    expect(() => whiteGains([150, 250, 250])).toThrow("not white");
  });

  test("a cast needing more than MAX_GAIN is refused; just under it is accepted", () => {
    expect(() => whiteGains([215, 250, 250])).toThrow("not white");
    expect(Math.max(...whiteGains([228, 250, 250]))).toBeLessThanOrEqual(MAX_GAIN);
  });
});

describe("measureWhite", () => {
  test("mean of the central 80 % and whether it is even", async () => {
    const path = join(tmpdir(), "white.png");
    // 100x100 white-ish patch with a dark 5 px border (outside the central 80 %)
    const px = Buffer.alloc(100 * 100 * 3);
    for (let y = 0; y < 100; y++)
      for (let x = 0; x < 100; x++) {
        const edge = x < 5 || y < 5 || x >= 95 || y >= 95;
        px.set(edge ? [0, 0, 0] : [240, 250, 252], (y * 100 + x) * 3);
      }
    await sharp(px, { raw: { width: 100, height: 100, channels: 3 } }).png().toFile(path);
    const m = await measureWhite(path);
    expect(m.mean.map(Math.round)).toEqual([240, 250, 252]);
    expect(m.even).toBe(true);
  });

  test("something on the glass (an uneven patch) is reported", async () => {
    const path = join(tmpdir(), "spot.png");
    const px = Buffer.alloc(100 * 100 * 3, 250);
    for (let y = 40; y < 60; y++) for (let x = 0; x < 100; x++) px.set([20, 20, 20], (y * 100 + x) * 3);
    await sharp(px, { raw: { width: 100, height: 100, channels: 3 } }).png().toFile(path);
    expect((await measureWhite(path)).even).toBe(false);
  });
});

test.skipIf(!magickAvailable())("colorPnmToPng applies white gains in linear light", async () => {
  const pnm = makeColourPnm([200, 200, 200], 4, 4);
  const out = join(tmpdir(), "gains.png");
  await colorPnmToPng(pnm, out, 8, null, [1.1, 1, 0.9]);
  const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
  const srgb = (l: number) => 255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055);
  expect(Math.abs(data[0]! - srgb(lin(200) * 1.1))).toBeLessThanOrEqual(1);
  expect(data[1]).toBe(200);
  expect(Math.abs(data[2]! - srgb(lin(200) * 0.9))).toBeLessThanOrEqual(1);
});
