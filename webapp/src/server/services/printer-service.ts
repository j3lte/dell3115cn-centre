import { PRINTER_OFF, type PrinterSource, type PrinterView } from "../printer";

/** The printer's state (supplies, alerts, page count); without a source (no printer configured) it answers `disabled`. */
export class PrinterService {
  constructor(private readonly source?: PrinterSource) {}

  get(): Promise<PrinterView> {
    return this.source ? this.source.get() : Promise.resolve({ ...PRINTER_OFF });
  }

  /** A fresh state when the source can refresh, else the same as `get`. */
  refresh(): Promise<PrinterView> {
    return this.source?.refresh ? this.source.refresh() : this.get();
  }
}
