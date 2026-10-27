import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type { DedaView, ScanView, Settings } from "../types/api";
import { keys } from "./query";

/**
 * After a profile is saved, deleted or added: its list is stale, and so are the settings, because a button profile may
 * point at a profile that is gone. Resolves once both are fetched again.
 */
export async function afterProfileChange(qc: QueryClient, kind: "input" | "output"): Promise<void> {
  await Promise.all([qc.invalidateQueries({ queryKey: kind === "input" ? keys.inputProfiles : keys.outputProfiles }), qc.invalidateQueries({ queryKey: keys.settings })]);
}

/** The server answered a settings change with the new settings; they replace the cached ones. */
export function afterSettings(qc: QueryClient, view: Settings): void {
  qc.setQueryData(keys.settings, view);
}

/**
 * One History page as cached: its scans, and the `before` cursor of the page after it, fixed when the page was fetched
 * (undefined: the server had nothing older). Live inserts and deletes change `scans`, never `next`.
 */
export type HistoryPage = { scans: ScanView[]; next: number | undefined };
/** History pages as cached; each page param is the `before` cursor the page was fetched with. */
type History = InfiniteData<HistoryPage, number | undefined>;

/**
 * The server sent a newer view of a scan (a mutation's answer or a live message): it replaces the scan's own query and
 * the scan wherever it sits in the cached History pages. A scan History doesn't hold yet goes to the top of the first
 * page when it is at least as new as the newest one there (or History is empty); an older one waits for the next
 * refetch. History that isn't cached stays uncached.
 */
export function applyScan(qc: QueryClient, scan: ScanView): void {
  qc.setQueryData(keys.scan(scan.id), scan);
  qc.setQueryData<History>(keys.history, (h) => {
    if (!h) return h;
    const has = (p: HistoryPage) => p.scans.some((s) => s.id === scan.id);
    if (h.pages.some(has)) return { ...h, pages: h.pages.map((p) => (has(p) ? { ...p, scans: p.scans.map((s) => (s.id === scan.id ? scan : s)) } : p)) };
    const newest = h.pages.flatMap((p) => p.scans)[0];
    if (newest && scan.createdAt < newest.createdAt) return h;
    // Only the first page grows; the cursors were fixed when the pages were fetched, so they are unchanged.
    const [first = { scans: [], next: undefined }, ...rest] = h.pages;
    return { ...h, pages: [{ ...first, scans: [scan, ...first.scans] }, ...rest] };
  });
}

/** A scan was deleted: it leaves the History pages and its own query. */
export function forgetScan(qc: QueryClient, id: string): void {
  qc.removeQueries({ queryKey: keys.scan(id), exact: true });
  qc.setQueryData<History>(keys.history, (h) => h && { ...h, pages: h.pages.map((p) => ({ ...p, scans: p.scans.filter((s) => s.id !== id) })) });
}

/**
 * The scan History fetches on its own: the selected one, when it isn't in the loaded pages (a deep link) and wasn't just
 * deleted. A deleted scan is gone from the pages too, but asking the server for it would only answer 404.
 */
export const deepLinkId = (selectedId: string | undefined, listed: boolean, deletedId: string | null) =>
  selectedId && !listed && selectedId !== deletedId ? selectedId : null;

/**
 * Whether History's scroll sentinel may load the next page by itself. Not after a failed next page: the observer would
 * ask again at once and keep failing; "Load more" retries it.
 */
export const autoLoadNext = (q: { hasNextPage: boolean; isFetching: boolean; isFetchNextPageError: boolean }) =>
  q.hasNextPage && !q.isFetching && !q.isFetchNextPageError;

/**
 * The server sent a newer view of a tracking-dot analysis (a mutation's answer): it replaces the cached one, or a new
 * one is put in its place by scan time, newest first, like the server lists them. An uncached list stays uncached.
 */
export function applyDeda(qc: QueryClient, view: DedaView): void {
  qc.setQueryData<DedaView[]>(keys.deda, (list) => {
    if (!list) return list;
    if (list.some((a) => a.id === view.id)) return list.map((a) => (a.id === view.id ? view : a));
    return [...list, view].sort((a, b) => b.scannedAt - a.scannedAt);
  });
}

/** An analysis was deleted: it leaves the cached list. */
export function forgetDeda(qc: QueryClient, id: string): void {
  qc.setQueryData<DedaView[]>(keys.deda, (list) => list?.filter((a) => a.id !== id));
}
