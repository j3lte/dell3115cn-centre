import { useState } from "react";
import type { OutputProfile, ScanView } from "../../types/api";
import { filterSummary } from "../../helpers/filter";
import { cx, plural } from "../../helpers/format";
import { outputChoices } from "../../helpers/scan";
import { useCancel } from "../../hooks/useCancel";
import { useMore } from "../../hooks/useMore";
import { useScanFilter } from "../../hooks/useScanFilter";
import { useSend } from "../../hooks/useSend";
import { FilterPanel } from "../filter/FilterPanel";
import { ErrorMessage } from "../form/ErrorMessage";
import { SelectField } from "../form/SelectField";
import { Confirm } from "../ui/Confirm";

/** Runs one tray action under `label` (busy state, error) and hands its answer to the tray. */
export type RunAction = (label: string) => (fn: () => Promise<ScanView>) => Promise<void>;

/** Review tray controls: the scan filter, scan more, send to an output profile, discard. */
export function ReviewControls({
  scan,
  outputs,
  scannerReady,
  busy,
  locked,
  error,
  run,
}: {
  scan: ScanView;
  outputs: readonly OutputProfile[];
  /** Why the scanner can't scan right now (null = ready). */
  scannerReady: string | null;
  busy: string | null;
  locked: boolean;
  error?: string;
  run: RunAction;
}) {
  const [outputId, setOutputId] = useState<number | undefined>(scan.outputProfileId ?? undefined);
  const [showFilter, setShowFilter] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const scanFilter = useScanFilter();
  const more = useMore();
  const cancel = useCancel();
  const send = useSend();

  const scanning = scan.status === "scanning";
  const flatbed = scan.inputProfile.source === "flatbed";
  const n = scan.pages.length;
  const sendOptions = outputChoices(outputs, outputId);

  return (
    <section className="flex flex-col gap-4">
      <div className="card">
        <button className="flex min-h-tap cursor-pointer items-center justify-between gap-3 text-left" aria-expanded={showFilter} onClick={() => setShowFilter(!showFilter)}>
          <span className="flex min-w-0 flex-col">
            <strong>Filter for all pages</strong>
            <small className="truncate text-muted">{filterSummary(scan.filter)}</small>
          </span>
          <span aria-hidden="true">{showFilter ? "▴" : "▾"}</span>
        </button>
        {showFilter && <FilterPanel value={scan.filter} disabled={locked} onChange={(f) => run("filter")(() => scanFilter.mutateAsync({ id: scan.id, filter: f }))} />}
      </div>
      <div className="card">
        <button className={cx("btn", flatbed && "btn-primary btn-big")} disabled={locked || !!scannerReady} onClick={() => run("more")(() => more.mutateAsync(scan.id))}>
          {flatbed ? "Scan next page" : "Scan more"}
        </button>
        {scannerReady && !scanning && <p className="hint text-center">{scannerReady}</p>}
        {scanning && (
          <button className="btn" onClick={() => run("cancel")(() => cancel.mutateAsync(scan.id))}>
            Stop scanning
          </button>
        )}
        <SelectField label="Send to" value={outputId ?? ""} options={sendOptions} onChange={(v) => setOutputId(Number(v))} disabled={locked} />
        <button className={cx("btn btn-big", !flatbed && "btn-primary")} disabled={locked || n === 0 || outputId === undefined} onClick={() => run("send")(() => send.mutateAsync({ id: scan.id, outputProfileId: outputId }))}>
          {busy === "send" ? "Sending…" : `Send ${plural(n, "page")}`}
        </button>
        {error && <ErrorMessage>{error}</ErrorMessage>}
        <button className="btn btn-danger" disabled={locked} onClick={() => setConfirmDiscard(true)}>
          Discard
        </button>
        <Confirm
          open={confirmDiscard}
          onOpenChange={setConfirmDiscard}
          title="Discard this scan?"
          body="It stays in history as cancelled."
          confirmLabel="Discard"
          onConfirm={() => run("cancel")(() => cancel.mutateAsync(scan.id))}
        />
      </div>
    </section>
  );
}
