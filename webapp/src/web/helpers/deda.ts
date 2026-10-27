import type { DedaView } from "../types/api";

/** How often the tracking-dot list is fetched again while an analysis is under way. */
export const DEDA_POLL_MS = 2000;

/** Whether an analysis is still under way (its scan or the analysis itself). */
export const dedaPending = (a: DedaView) => a.status === "scanning" || a.status === "analysing";

/** The list's refetch interval: `DEDA_POLL_MS` while any entry is pending, else no polling. */
export const dedaPoll = (analyses: readonly DedaView[] | undefined): number | false => (analyses?.some(dedaPending) ? DEDA_POLL_MS : false);

/** Close-ups an analysis may have, in the order shown, with their captions. */
export const DEDA_CLOSEUPS: readonly (readonly [name: string, caption: string])[] = [
  ["closeRaw", "Scan"],
  ["closeEnhanced", "Enhanced"],
  ["closeYellow", "Yellowness"],
];

/** Where an analysis image is served. */
export const dedaImageUrl = (id: string, name: string) => `/api/analyse/deda/${encodeURIComponent(id)}/images/${encodeURIComponent(name)}`;

/** Where the analysed page came from: "History page 2 · 300 dpi" or "Scanned from the glass". */
export const dedaSource = (a: DedaView) =>
  a.source === "scan" ? "Scanned from the glass" : `History page ${a.page ?? "?"}${a.dpi === null ? "" : ` · ${a.dpi} dpi`}`;
