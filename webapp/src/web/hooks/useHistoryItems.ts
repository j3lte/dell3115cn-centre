import { useCallback, useMemo } from "react";
import { errorText } from "../lib/errors";
import { useAutoLoadMore } from "./useAutoLoadMore";
import { useHistory } from "./useHistory";

/** The History list: scans from all loaded pages (each once), its state, the scroll sentinel and a stable "Load more". */
export function useHistoryItems() {
  const history = useHistory();
  const { fetchNextPage } = history;
  const sentinel = useAutoLoadMore(history);
  // Pages may overlap; each scan is shown once. A live scan lands in the cached pages (`applyScan`), so this follows it.
  const items = useMemo(() => [...new Map((history.data?.pages.flatMap((p) => p.scans) ?? []).map((s) => [s.id, s])).values()], [history.data]);
  // A page that is already on its way is not asked for again.
  const loadMore = useCallback(() => void fetchNextPage({ cancelRefetch: false }), [fetchNextPage]);
  return {
    items,
    loading: history.isPending || history.isFetchingNextPage,
    done: history.isSuccess && !history.hasNextPage,
    error: history.error ? errorText(history.error) : undefined,
    loadMore,
    sentinel,
  };
}
