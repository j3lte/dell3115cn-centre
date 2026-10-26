import { expect, test } from "bun:test";
import type { DeliveryView, OutputProfile, ScanView } from "../../src/web/types/api";
import { outputChoices, statusBadges, statusTitle } from "../../src/web/helpers/scan";

const outputs = [
  { id: 1, name: "To folder", destination: { type: "folder", config: {} } },
  { id: 2, name: "Paperless", destination: { type: "paperless", config: {} } },
  { id: 3, name: "Download", destination: { type: "download", config: {} } },
] as unknown as OutputProfile[];

const delivery = (id: number, outputProfileId: number, status: DeliveryView["status"], error?: string): DeliveryView => ({
  id,
  outputProfileId,
  outputProfileName: outputs.find((o) => o.id === outputProfileId)!.name,
  status,
  ...(error ? { error } : {}),
  files: [],
  createdAt: id,
});

const scan = (over: Partial<ScanView>): ScanView =>
  ({
    id: "s",
    createdAt: 1,
    status: "done",
    review: false,
    outputProfileId: 1,
    pages: [{ n: 1 }, { n: 2 }],
    deliveries: [],
    ...over,
  }) as unknown as ScanView;

test("a delivered scan whose resend failed still reads as sent, plus the failed resend", () => {
  const s = scan({ deliveries: [delivery(1, 1, "sent"), delivery(2, 2, "failed", "Paperless: 500")] });
  const t = statusTitle(s, outputs);
  expect(t.tone).toBe("ok");
  expect(t.title).toBe("✓ Sent 2 pages to To folder");
  expect(t.title).not.toContain("Not sent");
  expect(statusBadges(s, outputs)).toEqual([
    ["sent", "badge-ok"],
    ["resend failed", "badge-error"],
  ]);
});

test("a ready download stays 'ready' when a later resend failed", () => {
  const s = scan({ deliveries: [delivery(1, 3, "sent"), delivery(2, 2, "failed", "x")] });
  expect(statusTitle(s, outputs).title).toBe("✓ 2 pages ready to download");
  expect(statusBadges(s, outputs)[0]).toEqual(["ready", "badge-ok"]);
});

test("plain statuses", () => {
  expect(statusBadges(scan({ deliveries: [delivery(1, 1, "sent")] }), outputs)).toEqual([["sent", "badge-ok"]]);
  expect(statusBadges(scan({ status: "failed", deliveries: [delivery(1, 2, "failed", "x")], problem: "jam" }), outputs)).toEqual([
    ["failed", "badge-error"],
    ["partial", "badge-warn"],
  ]);
  expect(statusTitle(scan({ status: "failed", deliveries: [delivery(1, 2, "failed", "x")] }), outputs).title).toBe("Not sent: 2 pages kept in history");
});

test("outputChoices: a placeholder until one is chosen, a deleted choice kept, then the profiles", () => {
  const two = outputs.slice(0, 2);
  expect(outputChoices(two, undefined)).toEqual([["", "Choose an output profile"], [1, "To folder"], [2, "Paperless"]]);
  expect(outputChoices(two, 2)).toEqual([[1, "To folder"], [2, "Paperless"]]);
  expect(outputChoices(two, 9)).toEqual([[9, "(deleted profile)"], [1, "To folder"], [2, "Paperless"]]);
});
