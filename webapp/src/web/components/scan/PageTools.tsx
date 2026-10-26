import type { PageActions } from "../../types/ui";
import { cx } from "../../helpers/format";

/**
 * Move, rotate and delete buttons for page `n` of `count`: a compact `row` in the phone's page list, or a `bar` under
 * the large page (arrows point left/right on the desktop stage).
 */
export function PageTools({
  n,
  count,
  size,
  desktop,
  locked,
  actions,
}: {
  n: number;
  count: number;
  size: "row" | "bar";
  desktop: boolean;
  locked: boolean;
  actions: PageActions;
}) {
  return (
    <div className={cx("flex", size === "bar" ? "flex-wrap justify-center gap-2" : "gap-0.5")}>
      <button className="icon-btn" aria-label={`Move page ${n} earlier`} disabled={locked || n === 1} onClick={() => actions.move(n, n - 1)}>
        {size === "bar" && desktop ? "←" : "↑"}
      </button>
      <button className="icon-btn" aria-label={`Move page ${n} later`} disabled={locked || n === count} onClick={() => actions.move(n, n + 1)}>
        {size === "bar" && desktop ? "→" : "↓"}
      </button>
      <button className="icon-btn" aria-label={`Rotate page ${n}`} disabled={locked} onClick={() => actions.rotate(n)}>
        ↻
      </button>
      <button className="icon-btn text-danger" aria-label={`Delete page ${n}`} disabled={locked} onClick={() => actions.remove(n)}>
        🗑
      </button>
    </div>
  );
}
