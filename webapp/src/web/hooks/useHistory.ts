import { useInfiniteQuery } from "@tanstack/react-query";
import type { HistoryPage } from "../lib/cache";
import { client, unwrap } from "../lib/client";
import { keys } from "../lib/query";

/** Scans per History page. */
const HISTORY_PAGE_SIZE = 20;

/** Scan history, newest first; the next page asks for scans older than the last one shown (`before` = its `createdAt`). */
export const useHistory = () =>
  useInfiniteQuery({
    queryKey: keys.history,
    queryFn: async ({ pageParam }): Promise<HistoryPage> => {
      const scans = await unwrap(client.api.scans.$get({ query: { limit: String(HISTORY_PAGE_SIZE), ...(pageParam !== undefined && { before: String(pageParam) }) } }));
      // A full page may have older scans after it; a short one is the end.
      return { scans, next: scans.length < HISTORY_PAGE_SIZE ? undefined : scans[scans.length - 1]!.createdAt };
    },
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.next,
  });
