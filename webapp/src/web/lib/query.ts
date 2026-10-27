import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./errors";

/** One retry for a network error or a 5xx; an answer below 500 (a 404, say) is final, so the UI can react at once. */
export const retryQuery = (failures: number, e: unknown) => !(e instanceof ApiError && e.status > 0 && e.status < 500) && failures < 1;

/** The UI's server state cache: see `retryQuery`; no refetch when the window gets focus again. */
export const queryClient = new QueryClient({ defaultOptions: { queries: { retry: retryQuery, refetchOnWindowFocus: false } } });

/** Query keys; a scan's key sits under `["scans"]` with the history, so both can be invalidated together. */
export const keys = {
  inputProfiles: ["input-profiles"],
  outputProfiles: ["output-profiles"],
  settings: ["settings"],
  printer: ["printer"],
  features: ["features"],
  hostKey: (host: string, port: number) => ["host-keys", host.toLowerCase(), port],
  history: ["scans", "history"],
  scan: (id: string) => ["scans", id],
  deda: ["analyse", "deda"],
  dedaCandidates: ["analyse", "deda-candidates"],
} as const;
