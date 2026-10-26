import { expect, test } from "bun:test";
import { DEFAULT_FILTER, filterSummary } from "../../src/web/helpers/filter";

test("filterSummary mentions sharpening", () => {
  expect(filterSummary({ ...DEFAULT_FILTER, sharpen: "normal" })).toBe("Original · sharpen");
  expect(filterSummary({ ...DEFAULT_FILTER, preset: "document", sharpen: "light" })).toBe("Document · light sharpen");
  expect(filterSummary(DEFAULT_FILTER)).toBe("Original");
});
