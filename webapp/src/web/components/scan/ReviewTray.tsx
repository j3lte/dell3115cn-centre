import { useState } from "react";
import { errorText } from "../../lib/errors";
import type { OutputProfile, ScanView } from "../../types/api";
import type { PageActions } from "../../types/ui";
import { MEDIA } from "../../helpers/media";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { usePages } from "../../hooks/usePages";
import { useSelectedPage } from "../../hooks/useSelectedPage";
import { ReviewControls, type RunAction } from "./ReviewControls";
import { ReviewPageList } from "./ReviewPageList";
import { ReviewStage } from "./ReviewStage";

/**
 * Review tray. Renders two grid cells for the Scan page: controls (left column on desktop, below the pages on a phone)
 * and the stage (right column on desktop: filmstrip + selected page large + its filter panel; on a phone: page rows
 * with tools, tapping a page opens it in a sheet).
 */
export function ReviewTray({
  scan,
  outputs,
  scannerReady,
  onUpdate,
}: {
  scan: ScanView;
  outputs: readonly OutputProfile[];
  /** Why the scanner can't scan right now (null = ready). */
  scannerReady: string | null;
  onUpdate: (v: ScanView) => void;
}) {
  const desktop = useMediaQuery(MEDIA.lg);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useSelectedPage(scan);
  // The phone sheet shows the selected page, so it follows moves, removals and picks on the desktop stage.
  const [sheetOpen, setSheetOpen] = useState(false);
  const openSheet = (k: number | null) => {
    if (k !== null) setSelected(k);
    setSheetOpen(k !== null);
  };
  const pages = usePages();

  const n = scan.pages.length;
  const locked = scan.status === "scanning" || !!busy;

  const run: RunAction = (label) => async (fn) => {
    setBusy(label);
    setError(undefined);
    try {
      onUpdate(await fn());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const actions: PageActions = {
    move: (from, to) => {
      if (to < 1 || to > n || from === to) return;
      const order = scan.pages.map((p) => p.n);
      order.splice(to - 1, 0, ...order.splice(from - 1, 1));
      void run("reorder")(() => pages.mutateAsync({ id: scan.id, op: { order } })).then(() => selected === from && setSelected(to));
    },
    rotate: (k) => run("rotate")(() => pages.mutateAsync({ id: scan.id, op: { rotate: { n: k, degrees: 90 } } })),
    remove: (k) => run("remove")(() => pages.mutateAsync({ id: scan.id, op: { remove: k } })),
    setFilter: (k, f) => run("filter")(() => pages.mutateAsync({ id: scan.id, op: { filter: { n: k, filter: f } } })),
  };

  return (
    <>
      <div className="order-2 lg:order-none lg:col-start-1 lg:row-start-1">
        <ReviewControls scan={scan} outputs={outputs} scannerReady={scannerReady} busy={busy} locked={locked} error={error} run={run} />
      </div>
      <div className="order-1 min-w-0 lg:order-none lg:col-start-2 lg:row-start-1">
        {desktop ? (
          <ReviewStage scan={scan} busy={!!busy} locked={locked} selected={selected} onSelect={setSelected} actions={actions} />
        ) : (
          <ReviewPageList scan={scan} busy={!!busy} locked={locked} actions={actions} sheetPage={sheetOpen ? (selected ?? null) : null} onSheetPage={openSheet} />
        )}
      </div>
    </>
  );
}
