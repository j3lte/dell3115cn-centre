import { useState } from "react";
import { cx, formatWhen } from "../../helpers/format";
import { useDedaCandidates } from "../../hooks/useDedaCandidates";
import { useDedaFromHistory } from "../../hooks/useDedaFromHistory";
import { errorText } from "../../lib/errors";
import { ErrorMessage } from "../form/ErrorMessage";
import { Sheet } from "../ui/Sheet";
import { Spinner } from "../ui/Spinner";

type Choice = { scanId: string; page: number; lowDpi: boolean };

/** Sheet to pick a colour page of at least 300 dpi from History and analyse it; warns below 600 dpi. */
export function DedaPicker({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [chosen, setChosen] = useState<Choice | null>(null);
  const candidates = useDedaCandidates(open);
  const start = useDedaFromHistory();
  const scans = candidates.data;

  const close = (v: boolean) => {
    if (!v) setChosen(null);
    onOpenChange(v);
  };

  return (
    <Sheet open={open} onOpenChange={close} title="Pick a page from History">
      {candidates.isPending && <Spinner />}
      {candidates.error && <ErrorMessage>{errorText(candidates.error)}</ErrorMessage>}
      {scans?.length === 0 && <p className="hint">No colour scans of at least 300 dpi in History.</p>}
      {scans && scans.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {scans.map((s) => (
            <li key={s.id} className="flex flex-col gap-1.5">
              <strong>{formatWhen(s.createdAt)}</strong>
              <div className="flex flex-wrap gap-2">
                {s.pages.map((p) => {
                  const on = chosen?.scanId === s.id && chosen.page === p.n;
                  return (
                    <button key={p.n} aria-pressed={on} className={cx("chip", on && "border-accent bg-accent-soft text-accent")} onClick={() => setChosen({ scanId: s.id, page: p.n, lowDpi: p.lowDpi })}>
                      Page {p.n} · {p.dpi} dpi
                    </button>
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
      )}
      {chosen?.lowDpi && <p className="msg msg-warn">Below 600 dpi the dots are hard to see; results may miss them.</p>}
      {start.error && <ErrorMessage>{errorText(start.error)}</ErrorMessage>}
      <button
        className="btn btn-primary"
        disabled={!chosen || start.isPending}
        onClick={() => chosen && start.mutate({ scanId: chosen.scanId, page: chosen.page }, { onSuccess: () => close(false) })}
      >
        Analyse
      </button>
    </Sheet>
  );
}
