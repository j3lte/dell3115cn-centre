import { useState } from "react";
import { useDedaScan } from "../../hooks/useDedaScan";
import { errorText } from "../../lib/errors";
import { ErrorMessage } from "../form/ErrorMessage";
import { DedaPicker } from "./DedaPicker";

/** Start an analysis: scan a page on the glass (colour, 600 dpi; off while one is scanning) or pick a page from History. */
export function DedaActions({ glassBusy }: { glassBusy: boolean }) {
  const [picking, setPicking] = useState(false);
  const scan = useDedaScan();
  return (
    <div className="card">
      <p className="hint">Put a printed page face down on the glass, or analyse a colour page you scanned before.</p>
      {/* Stacked full width on a phone: side by side the labels do not fit. */}
      <div className="flex flex-col gap-2.5 sm:flex-row">
        <button className="btn btn-primary sm:flex-1" disabled={scan.isPending || glassBusy} onClick={() => scan.mutate()}>
          Scan page from glass
        </button>
        <button className="btn sm:flex-1" onClick={() => setPicking(true)}>
          Pick from History
        </button>
      </div>
      {scan.error && <ErrorMessage>{errorText(scan.error)}</ErrorMessage>}
      <DedaPicker open={picking} onOpenChange={setPicking} />
    </div>
  );
}
