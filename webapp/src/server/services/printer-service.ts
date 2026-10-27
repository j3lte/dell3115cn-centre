import { PRINTER_OFF, type PrinterSource, type PrinterView } from "../printer";

const HOUR_MS = 3_600_000;

/** The printer's state (supplies, alerts, page count); without a source (no printer configured) it answers `disabled`. */
export class PrinterService {
  constructor(
    private readonly source?: PrinterSource,
    /** The printerWakeHours setting: how old the last read may be before opening the app wakes the printer. */
    private readonly wakeHours: () => number | null = () => null,
  ) {}

  get(): Promise<PrinterView> {
    return this.source ? this.source.get() : Promise.resolve({ ...PRINTER_OFF });
  }

  /** A fresh state when the source can refresh, else the same as `get`. */
  refresh(): Promise<PrinterView> {
    return this.source?.refresh ? this.source.refresh() : this.get();
  }

  /** Opening the app: a fresh state when the last read is older than the wake setting (off: the same as `get`). */
  refreshIfStale(): Promise<PrinterView> {
    const hours = this.wakeHours();
    return hours !== null && this.source?.refreshIfStale ? this.source.refreshIfStale(hours * HOUR_MS) : this.get();
  }
}
