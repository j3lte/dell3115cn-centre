import type { RefObject } from "react";
import type { OutputProfile, ScanView } from "../../types/api";
import { Spinner } from "../ui/Spinner";
import { HistoryRow } from "./HistoryRow";

/** The History list with its error, empty state and the scroll sentinel (with the "Load more" fallback) below it. */
export function HistoryList({
  items,
  outputs,
  selectedId,
  error,
  loading,
  done,
  onLoadMore,
  sentinel,
}: {
  items: ScanView[];
  outputs: readonly OutputProfile[];
  selectedId: string | undefined;
  error: string | undefined;
  loading: boolean;
  done: boolean;
  onLoadMore: () => void;
  sentinel: RefObject<HTMLDivElement | null>;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h1 className="m-0 px-1 text-2xl font-bold">History</h1>
      {error && <p className="msg msg-error">{error}</p>}
      {!loading && done && items.length === 0 && <p className="card text-muted">No scans yet.</p>}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {items.map((s) => (
          <HistoryRow key={s.id} scan={s} outputs={outputs} active={s.id === selectedId} />
        ))}
      </ul>
      <div ref={sentinel} className="flex min-h-10 items-center justify-center">
        {loading && <Spinner />}
        {!loading && !done && items.length > 0 && (
          <button className="btn btn-sm" onClick={onLoadMore}>
            Load more
          </button>
        )}
      </div>
    </section>
  );
}
