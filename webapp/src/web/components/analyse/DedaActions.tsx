import { useState } from "react";
import { useDedaScan } from "../../hooks/useDedaScan";
import { errorText } from "../../lib/errors";
import { ErrorMessage } from "../form/ErrorMessage";
import { DedaPicker } from "./DedaPicker";

/** Start an analysis: scan a page on the glass (colour, 600 dpi) or pick a page from History. */
export function DedaActions() {
  const [picking, setPicking] = useState(false);
  const scan = useDedaScan();
  return (
    <div className="card">
      <p className="hint">Put a printed page face down on the glass, or analyse a colour page you scanned before.</p>
      <div className="flex flex-wrap gap-2.5">
        <button className="btn btn-primary flex-1" disabled={scan.isPending} onClick={() => scan.mutate()}>
          Scan page from glass
        </button>
        <button className="btn flex-1" onClick={() => setPicking(true)}>
          Pick from History
        </button>
      </div>
      {scan.error && <ErrorMessage>{errorText(scan.error)}</ErrorMessage>}
      <DedaPicker open={picking} onOpenChange={setPicking} />
    </div>
  );
}
