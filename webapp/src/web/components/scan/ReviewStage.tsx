import { useState } from "react";
import type { ScanView } from "../../types/api";
import type { PageActions } from "../../types/ui";
import { cx } from "../../helpers/format";
import { LargePage } from "./LargePage";
import { PageFilter } from "./PageFilter";
import { PageTools } from "./PageTools";
import { ReviewHeader } from "./ReviewHeader";

/** Desktop review stage: draggable filmstrip, the selected page large with its tools, and that page's filter. */
export function ReviewStage({
  scan,
  busy,
  locked,
  selected,
  onSelect,
  actions,
}: {
  scan: ScanView;
  busy: boolean;
  locked: boolean;
  selected: number | undefined;
  onSelect: (n: number) => void;
  actions: PageActions;
}) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const n = scan.pages.length;
  return (
    <section className="card min-h-0 lg:sticky lg:top-6 lg:h-[calc(100dvh-3rem)]">
      <ReviewHeader scan={scan} busy={busy} />
      {n > 0 && (
        <ol aria-label="Pages" className="m-0 flex list-none gap-2 overflow-x-auto p-1">
          {scan.pages.map((p) => (
            <li
              key={p.n}
              className={cx("relative flex-none", dragFrom === p.n && "opacity-40")}
              draggable={!locked}
              onDragStart={() => setDragFrom(p.n)}
              onDragEnd={() => setDragFrom(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragFrom !== null) actions.move(dragFrom, p.n);
                setDragFrom(null);
              }}
            >
              <button
                className={cx("block cursor-pointer rounded-lg p-0.5", selected === p.n && "ring-3 ring-accent")}
                aria-pressed={selected === p.n}
                aria-label={`Page ${p.n}`}
                onClick={() => onSelect(p.n)}
              >
                <img src={p.thumbUrl} alt="" draggable={false} className="paper block h-24 w-auto" />
              </button>
              <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded-md bg-black/60 px-1.5 text-xs text-white">{p.n}</span>
              {p.filter && <span className="badge badge-busy pointer-events-none absolute top-1.5 right-1.5">own</span>}
            </li>
          ))}
        </ol>
      )}
      {selected && (
        <LargePage scan={scan} n={selected} footer={<PageTools n={selected} count={n} size="bar" desktop locked={locked} actions={actions} />}>
          <div className="flex w-full flex-col gap-3 overflow-y-auto xl:w-80">
            <h3 className="m-0 text-base font-bold">Page {selected} filter</h3>
            <PageFilter scan={scan} n={selected} locked={locked} actions={actions} />
          </div>
        </LargePage>
      )}
      {n > 0 && <p className="hint">Drag thumbnails to reorder.</p>}
    </section>
  );
}
