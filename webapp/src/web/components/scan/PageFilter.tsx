import type { ScanView } from "../../types/api";
import type { PageActions } from "../../types/ui";
import { filterSummary } from "../../helpers/filter";
import { FilterPanel } from "../filter/FilterPanel";

/** Filter of page `n`: its own filter, or the scan filter until it gets one. */
export function PageFilter({ scan, n, locked, actions }: { scan: ScanView; n: number; locked: boolean; actions: PageActions }) {
  const p = scan.pages.find((x) => x.n === n);
  if (!p) return null;
  return (
    <div className="flex flex-col gap-3">
      <p className="hint">{p.filter ? `Own filter: ${filterSummary(p.filter)}` : `Uses the scan filter: ${filterSummary(scan.filter)}`}</p>
      <FilterPanel value={p.filter ?? scan.filter} disabled={locked} onChange={(f) => actions.setFilter(n, f)} />
      <button className="btn" disabled={!p.filter || locked} onClick={() => actions.setFilter(n, null)}>
        Use scan filter
      </button>
    </div>
  );
}
