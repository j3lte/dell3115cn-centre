import { useEffect, useRef } from "react";
import { autoLoadNext } from "../lib/cache";

/**
 * Infinite scroll: the returned ref goes on a sentinel below the list; when it comes into view (400 px early) the next
 * page loads. A page that is already on its way is not asked for again, and a failed next page is not retried by the
 * observer ("Load more" does that).
 */
export function useAutoLoadMore(q: { hasNextPage: boolean; isFetching: boolean; isFetchNextPageError: boolean; fetchNextPage: (o: { cancelRefetch: boolean }) => unknown }) {
  const sentinel = useRef<HTMLDivElement>(null);
  const { fetchNextPage } = q;
  const autoLoad = autoLoadNext(q);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !autoLoad) return;
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && void fetchNextPage({ cancelRefetch: false }), { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [fetchNextPage, autoLoad]);
  return sentinel;
}
