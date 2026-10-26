import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState, type Dispatch } from "react";
import { deepLinkId, forgetScan } from "../lib/cache";
import { go } from "../lib/router";
import type { LiveAction } from "../types/ui";
import type { ScanView } from "../types/api";
import { useScan } from "./useScan";

/**
 * The scan History shows in detail: the selected one from the list, or fetched on its own when a deep link points
 * beyond the loaded pages (`missing` when the server doesn't know it). `onDeleted` leaves the scan's screen first, then
 * forgets it, so nothing asks the server for it; `onUpdate` feeds a scan the server changed into the live state.
 */
export function useHistorySelection(items: ScanView[], selectedId: string | undefined, dispatch: Dispatch<LiveAction>) {
  const qc = useQueryClient();
  const inList = items.find((s) => s.id === selectedId);
  const [deletedId, setDeletedId] = useState<string | null>(null);
  const extra = useScan(deepLinkId(selectedId, !!inList, deletedId));
  const selected = inList ?? (selectedId ? extra.data : undefined);

  const onDeleted = useCallback(
    (id: string) => {
      // One batch: History stops fetching this id before the cache forgets it, so no request goes out for it.
      setDeletedId(id);
      forgetScan(qc, id);
      dispatch({ type: "forget", id });
      go("history");
    },
    [qc, dispatch],
  );
  const onUpdate = useCallback((scan: ScanView) => dispatch({ type: "scan", scan }), [dispatch]);

  return { selected, missing: !selected && !!selectedId && extra.isError, onDeleted, onUpdate };
}
