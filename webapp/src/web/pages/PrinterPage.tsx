import { SupplyBar } from "../components/printer/SupplyBar";
import { CardTitle } from "../components/ui/CardTitle";
import { cx, formatWhenShort } from "../helpers/format";
import type { Printer } from "../types/ui";

/** Printer tab: alerts, toner, belt unit and fuser levels, and the page count, all from the printer's CUPS queue. */
export function PrinterPage({ printer: { view: printer, checking, check } }: { printer: Printer }) {
  if (!printer) return <p className="hint">Loading…</p>;
  if (printer.disabled) return <p className="msg">Printer status is off (PRINTER_URI=off).</p>;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <h1 className="m-0 text-2xl font-bold">Printer</h1>
        <button className="btn btn-sm" type="button" onClick={() => void check()} disabled={checking}>
          {checking ? "Checking…" : "Check now"}
        </button>
      </div>
      {printer.error && <p className="msg msg-error m-0">{printer.error}</p>}

      {printer.alerts.length > 0 && (
        <section className={cx("card gap-2", printer.severity === "error" ? "border-danger bg-danger-soft" : "border-warn bg-warn-soft")} role="alert">
          <CardTitle className={printer.severity === "error" ? "text-danger" : "text-warn"}>
            {printer.severity === "error" ? "Printing is blocked" : "Needs attention"}
          </CardTitle>
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
            {printer.alerts.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </section>
      )}

      {printer.supplies.length > 0 && (
        <section className="card gap-2" aria-label="Supplies">
          <CardTitle>Supplies</CardTitle>
          <ul className="m-0 grid list-none grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2 p-0">
            {printer.supplies.map((s) => (
              <SupplyBar key={s.name} supply={s} />
            ))}
          </ul>
        </section>
      )}

      {printer.pageCount !== null && (
        <section className="card gap-1">
          <CardTitle>Pages printed</CardTitle>
          <p className="m-0 text-2xl font-bold tabular-nums">{printer.pageCount.toLocaleString()}</p>
        </section>
      )}

      <p className="hint m-0 px-1">
        The printer reports its state after each print job. While it sleeps it doesn't notice changes (an opened cover,
        refilled paper); <strong>Check now</strong> wakes it without printing and reads it again. Opening the app does
        that too when the last check is old (Settings → Printer).
        {printer.readAt !== null && (
          <> Last read from the printer: {formatWhenShort(printer.readAt)}.</>
        )}
      </p>
    </div>
  );
}
