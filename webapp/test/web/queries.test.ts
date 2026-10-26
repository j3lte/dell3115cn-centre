import { expect, test } from "bun:test";
import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import type { ScanView, Settings } from "../../src/web/types/api";
import { ApiError } from "../../src/web/lib/errors";
import { afterProfileChange, afterSettings, applyScan, autoLoadNext, deepLinkId, forgetScan, type HistoryPage } from "../../src/web/lib/cache";
import { keys, retryQuery } from "../../src/web/lib/query";

/** A cache with all three lists loaded (so `isInvalidated` means something). */
function loaded() {
  const qc = new QueryClient();
  qc.setQueryData(keys.inputProfiles, []);
  qc.setQueryData(keys.outputProfiles, []);
  qc.setQueryData(keys.settings, {});
  return qc;
}
const stale = (qc: QueryClient, key: readonly unknown[]) => qc.getQueryState(key)!.isInvalidated;

test("afterProfileChange('output') invalidates output profiles and settings, not input profiles", async () => {
  const qc = loaded();
  await afterProfileChange(qc, "output");
  expect(stale(qc, keys.outputProfiles)).toBe(true);
  expect(stale(qc, keys.settings)).toBe(true);
  expect(stale(qc, keys.inputProfiles)).toBe(false);
});

test("afterProfileChange('input') invalidates input profiles and settings, not output profiles", async () => {
  const qc = loaded();
  await afterProfileChange(qc, "input");
  expect(stale(qc, keys.inputProfiles)).toBe(true);
  expect(stale(qc, keys.settings)).toBe(true);
  expect(stale(qc, keys.outputProfiles)).toBe(false);
});

test("afterSettings writes the view into the cache", () => {
  const qc = loaded();
  const view = { cleanupDays: 7 } as Settings;
  afterSettings(qc, view);
  expect(qc.getQueryData(keys.settings)).toEqual(view);
});

const scan = (id: string, over: Partial<ScanView> = {}) => ({ id, status: "review", createdAt: 1, pages: [], deliveries: [], ...over }) as unknown as ScanView;

/** A cache with two history pages loaded, newest first: [a, b] and [c]. */
function withHistory() {
  const qc = new QueryClient();
  const data: InfiniteData<HistoryPage, number | undefined> = {
    pages: [
      { scans: [scan("a", { createdAt: 30 }), scan("b", { createdAt: 20 })], next: 20 },
      { scans: [scan("c", { createdAt: 10 })], next: undefined },
    ],
    pageParams: [undefined, 20],
  };
  qc.setQueryData(keys.history, data);
  return qc;
}
const history = (qc: QueryClient) => qc.getQueryData<InfiniteData<HistoryPage>>(keys.history)!;
/** The scan ids per cached History page. */
const ids = (qc: QueryClient) => history(qc).pages.map((p) => p.scans.map((s) => s.id));

test("applyScan updates the scan in cached history pages", () => {
  const qc = withHistory();
  applyScan(qc, scan("c", { status: "done" }));
  const h = history(qc);
  expect(h.pages[1]!.scans.map((s) => [s.id, s.status])).toEqual([["c", "done"]]);
  expect(h.pages[0]!.scans.map((s) => s.status)).toEqual(["review", "review"]);
});

test("applyScan inserts a newer unknown scan at the top of the first page", () => {
  const qc = withHistory();
  applyScan(qc, scan("new", { status: "scanning", createdAt: 40 }));
  expect(ids(qc)).toEqual([["new", "a", "b"], ["c"]]);
  expect(history(qc).pages.map((p) => p.next)).toEqual([20, undefined]);
});

test("applyScan inserts into an empty History", () => {
  const qc = new QueryClient();
  qc.setQueryData(keys.history, { pages: [{ scans: [], next: undefined }], pageParams: [undefined] });
  applyScan(qc, scan("new", { createdAt: 5 }));
  expect(ids(qc)).toEqual([["new"]]);
});

test("applyScan does not insert an older unknown scan", () => {
  const qc = withHistory();
  applyScan(qc, scan("old", { createdAt: 25 }));
  expect(ids(qc)).toEqual([["a", "b"], ["c"]]);
});

test("applyScan does nothing to History when History isn't cached", () => {
  const qc = new QueryClient();
  applyScan(qc, scan("new", { createdAt: 40 }));
  expect(qc.getQueryData(keys.history)).toBeUndefined();
});

test("applyScan sets the scan's own query", () => {
  const qc = new QueryClient();
  const v = scan("a", { status: "delivering" });
  applyScan(qc, v);
  expect(qc.getQueryData(keys.scan("a"))).toEqual(v);
});

test("forgetScan removes the scan from history and drops its query", () => {
  const qc = withHistory();
  qc.setQueryData(keys.scan("b"), scan("b"));
  forgetScan(qc, "b");
  expect(ids(qc)).toEqual([["a"], ["c"]]);
  expect(history(qc).pages.map((p) => p.next)).toEqual([20, undefined]);
  expect(qc.getQueryState(keys.scan("b"))).toBeUndefined();
});

test("autoLoadNext loads the next page only when there is one and nothing is fetching or failed", () => {
  const q = { hasNextPage: true, isFetching: false, isFetchNextPageError: false };
  expect(autoLoadNext(q)).toBe(true);
  expect(autoLoadNext({ ...q, hasNextPage: false })).toBe(false);
  expect(autoLoadNext({ ...q, isFetching: true })).toBe(false);
  // A failed next page is retried with "Load more", not by the observer (which would loop on a persistent error).
  expect(autoLoadNext({ ...q, isFetchNextPageError: true })).toBe(false);
});

test("retryQuery retries a network error or a 5xx once, never a 4xx", () => {
  expect(retryQuery(0, new ApiError("offline", "network", 0))).toBe(true);
  expect(retryQuery(0, new ApiError("boom", "internal", 500))).toBe(true);
  expect(retryQuery(1, new ApiError("boom", "internal", 500))).toBe(false);
  expect(retryQuery(0, new ApiError("gone", "not_found", 404))).toBe(false);
  expect(retryQuery(0, new Error("other"))).toBe(true);
});

test("deepLinkId fetches a selected scan on its own only when it isn't listed and wasn't just deleted", () => {
  expect(deepLinkId(undefined, false, null)).toBeNull();
  expect(deepLinkId("a", true, null)).toBeNull();
  expect(deepLinkId("a", false, null)).toBe("a");
  expect(deepLinkId("a", false, "a")).toBeNull();
  expect(deepLinkId("b", false, "a")).toBe("b");
});
