import { HistoryList } from "../components/history/HistoryList";
import { ScanDetail } from "../components/history/ScanDetail";
import { EmptyState } from "../components/ui/EmptyState";
import { Spinner } from "../components/ui/Spinner";
import { MEDIA } from "../helpers/media";
import { useHashParts } from "../hooks/useHashParts";
import { useHistoryItems } from "../hooks/useHistoryItems";
import { useHistorySelection } from "../hooks/useHistorySelection";
import type { Live } from "../hooks/useLive";
import { useMediaQuery } from "../hooks/useMediaQuery";
import type { Profiles } from "../types/ui";

export function HistoryPage({ live, profiles }: { live: Live; profiles: Profiles }) {
  const selectedId = useHashParts()[1];
  const desktop = useMediaQuery(MEDIA.lg);
  const { items, loading, done, error, loadMore, sentinel } = useHistoryItems();
  const { selected, missing, onDeleted, onUpdate } = useHistorySelection(items, selectedId, live.dispatch);

  const list = <HistoryList items={items} outputs={profiles.outputs} selectedId={selectedId} error={error} loading={loading} done={done} onLoadMore={loadMore} sentinel={sentinel} />;

  const detail = selected ? (
    <ScanDetail key={selected.id} scan={selected} outputs={profiles.outputs} desktop={desktop} onUpdate={onUpdate} onDeleted={onDeleted} />
  ) : missing ? (
    <p className="card text-muted">This scan no longer exists.</p>
  ) : null;

  if (desktop)
    return (
      <div className="grid grid-cols-[minmax(320px,400px)_minmax(0,1fr)] items-start gap-6">
        {list}
        <div className="min-w-0 lg:sticky lg:top-6 lg:max-h-[calc(100dvh-3rem)] lg:overflow-y-auto lg:rounded-2xl">{detail ?? <EmptyState>Select a scan to see its pages and deliveries.</EmptyState>}</div>
      </div>
    );
  if (selectedId)
    return (
      <div className="flex flex-col gap-3">
        <a href="#/history" className="btn self-start">
          ← History
        </a>
        {detail ?? <Spinner />}
      </div>
    );
  return list;
}
