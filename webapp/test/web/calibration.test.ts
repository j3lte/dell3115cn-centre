import { expect, test } from "bun:test";
import { calibrationSummary } from "../../src/web/helpers/settings";

test("calibrationSummary: which channels are raised, by how much", () => {
  expect(calibrationSummary({ gains: [1.094, 1, 1.004], white: [244, 254, 253], at: 0 })).toBe("Red +9\u00a0% · paper measured 244 / 254 / 253");
  expect(calibrationSummary({ gains: [1.05, 1.02, 1], white: [246, 250, 252], at: 0 })).toBe("Red +5\u00a0%, green +2\u00a0% · paper measured 246 / 250 / 252");
  expect(calibrationSummary({ gains: [1, 1, 1], white: [250, 250, 250], at: 0 })).toBe("No correction needed · paper measured 250 / 250 / 250");
});
