import { expect, test } from "bun:test";
import { outputNames as exampleFileNames } from "../../src/server/output/filename";

const date = new Date(2026, 9, 26, 9, 5, 7);
const ctx = { date, outputProfile: "To Paperless", inputProfile: "Feeder gray", seq: 12 };

test("example file name follows the encoder's rules per format", () => {
  expect(exampleFileNames("{date}_{time}_scan", "pdf_multi", ctx)).toEqual(["2026-10-26_0905_scan.pdf"]);
  expect(exampleFileNames("{date}_scan.pdf", "pdf_multi", ctx)).toEqual(["2026-10-26_scan.pdf"]);
  expect(exampleFileNames("{profile}-{n}", "pdf_single", ctx, 2)).toEqual(["to-paperless-0012_001.pdf", "to-paperless-0012_002.pdf"]);
  expect(exampleFileNames("scan_{page}", "jpeg", ctx, 2)).toEqual(["scan_001.jpg", "scan_002.jpg"]);
  expect(exampleFileNames("scan", "png", ctx, 2)).toEqual(["scan.png", "scan-2.png"]);
  expect(exampleFileNames("{datetime}", "tiff_multi", ctx)).toEqual(["2026-10-26_090507.tif"]);
});
