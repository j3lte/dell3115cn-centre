import type { ScanView } from "../../types/api";
import type { PageActions } from "../../types/ui";
import { Sheet } from "../ui/Sheet";
import { PageFilter } from "./PageFilter";
import { PageTools } from "./PageTools";
import { ReviewHeader } from "./ReviewHeader";

/**
 * Phone review stage: one row per page with its tools; tapping a page opens it in a sheet with its filter. The open page
 * (`sheetPage`) is the tray's selected page, so it survives the switch to the desktop stage and back.
 */
export function ReviewPageList({
  scan,
  busy,
  locked,
  actions,
  sheetPage,
  onSheetPage,
}: {
  scan: ScanView;
  busy: boolean;
  locked: boolean;
  actions: PageActions;
  sheetPage: number | null;
  onSheetPage: (n: number | null) => void;
}) {
  const scanning = scan.status === "scanning";
  const n = scan.pages.length;
  return (
    <section className="flex flex-col gap-3">
      <div className="card">
        <ReviewHeader scan={scan} busy={busy} />
      </div>
      {n > 0 && (
        <ol aria-label="Pages" className="m-0 flex list-none flex-col gap-2 p-0">
          {scan.pages.map((p) => (
            <li key={p.n} className="card flex-row items-center gap-3 p-2">
              <button className="relative flex-none cursor-pointer" onClick={() => onSheetPage(p.n)} aria-label={`Page ${p.n}: open`} disabled={scanning}>
                <img src={p.thumbUrl} alt="" className="paper block h-20 w-16 object-cover object-top" />
              </button>
              <div className="flex min-w-0 flex-1 flex-col">
                <strong>Page {p.n}</strong>
                {p.filter && <span className="badge badge-busy self-start">own filter</span>}
              </div>
              <PageTools n={p.n} count={n} size="row" desktop={false} locked={locked} actions={actions} />
            </li>
          ))}
        </ol>
      )}
      <Sheet open={sheetPage !== null} onOpenChange={(o) => !o && onSheetPage(null)} title={`Page ${sheetPage ?? ""}`}>
        {sheetPage !== null && (
          <>
            <img src={scan.pages.find((p) => p.n === sheetPage)?.viewUrl} alt={`Page ${sheetPage}`} className="paper mx-auto max-h-[45dvh] w-auto max-w-full" />
            <PageTools n={sheetPage} count={n} size="bar" desktop={false} locked={locked} actions={actions} />
            <PageFilter scan={scan} n={sheetPage} locked={locked} actions={actions} />
          </>
        )}
      </Sheet>
    </section>
  );
}
