import { expect, test } from "bun:test";
import type { InputProfile, OutputProfile, ScanView } from "../../src/web/types/api";
import { downloadFirst, historySend, scanSettingsSummary, statusBadges, statusTitle } from "../../src/web/helpers/scan";
import { mcpClientSnippets } from "../../src/web/helpers/settings";

const filter = { preset: "none", threshold: 160, brightness: 0, contrast: 0, autoCrop: false, deskew: false } as const;
const profile = (over: Partial<InputProfile>): InputProfile =>
  ({ id: 0, name: "MCP scan", source: "flatbed", mode: "color", dpi: 600, paper: "glass", autoOrient: false, threshold: 128, filter, ...over }) as InputProfile;

test("mcpClientSnippets", () => {
  const s = mcpClientSnippets("http://h:8080/mcp/", "K");
  expect(s.claudeCode).toBe('claude mcp add --transport http scanner http://h:8080/mcp/ --header "Authorization: Bearer K"');
  expect(s.header).toBe("Authorization: Bearer K");
});

test("scanSettingsSummary: source, mode, dpi, 16-bit only when set, area", () => {
  expect(scanSettingsSummary(profile({ depth: 16 }), [10, 20, 30, 40])).toBe("Flatbed · Colour · 600 dpi · 16-bit · area 30×40 mm at 10, 20");
  expect(scanSettingsSummary(profile({ depth: 8 }))).toBe("Flatbed · Colour · 600 dpi");
  expect(scanSettingsSummary(profile({ source: "adf", mode: "lineart", dpi: 300, paper: "letter" }))).toBe("Feeder · Black & white · 300 dpi · Letter");
});

test("scanSettingsSummary: A4 feeder scan, flatbed region scan, and a feeder profile with glass paper stay as before", () => {
  expect(scanSettingsSummary(profile({ source: "adf", mode: "gray", dpi: 300, paper: "a4" }))).toBe("Feeder · Gray · 300 dpi · A4");
  expect(scanSettingsSummary(profile({ source: "flatbed", mode: "color", dpi: 600, paper: "glass" }), [12.5, 0, 100, 150.25])).toBe(
    "Flatbed · Colour · 600 dpi · area 100×150.3 mm at 12.5, 0",
  );
  // History never shows the paper line for "glass"; only the Profiles page labels it "Full glass".
  expect(scanSettingsSummary(profile({ source: "adf", paper: "glass" }))).toBe("Feeder · Colour · 600 dpi");
});

test("statusBadges: ready assistant scans show not sent and MCP", () => {
  const s = { status: "ready", origin: "mcp", deliveries: [], pages: [] } as unknown as ScanView;
  expect(statusBadges(s, [])).toEqual([
    ["not sent", ""],
    ["MCP", "badge-mcp"],
  ]);
});

test("downloadFirst lists Download profiles first, keeping their order", () => {
  const outs = [
    { id: 1, name: "Paperless", destination: { type: "paperless" } },
    { id: 2, name: "Download PDF", destination: { type: "download" } },
    { id: 3, name: "Folder", destination: { type: "folder" } },
    { id: 4, name: "Download PNG", destination: { type: "download" } },
  ] as unknown as OutputProfile[];
  expect(downloadFirst(outs).map((o) => o.id)).toEqual([2, 4, 1, 3]);
});

test("statusTitle for a ready assistant scan says it is not sent", () => {
  const s = { status: "ready", origin: "mcp", deliveries: [], pages: [{ n: 1 }, { n: 2 }] } as unknown as ScanView;
  expect(statusTitle(s, [])).toEqual({ title: "2 pages scanned by an assistant, not sent", tone: "muted" });
});

test("historySend: Send for ready and never-sent cancelled scans, Resend after a delivery", () => {
  const scan = (status: string, pages: number, deliveries: number) =>
    ({ status, pages: Array(pages).fill({}), deliveries: Array(deliveries).fill({}) }) as unknown as ScanView;
  expect(historySend(scan("ready", 1, 0))).toBe("send");
  expect(historySend(scan("cancelled", 2, 0))).toBe("resend");
  expect(historySend(scan("done", 1, 1))).toBe("resend");
  expect(historySend(scan("failed", 1, 1))).toBe("resend");
  expect(historySend(scan("cancelled", 0, 0))).toBeNull();
  expect(historySend(scan("review", 1, 0))).toBeNull();
  expect(historySend(scan("delivering", 1, 1))).toBeNull();
});
