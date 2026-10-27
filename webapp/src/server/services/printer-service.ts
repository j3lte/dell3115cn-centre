import { PRINTER_OFF, type PrinterSource, type PrinterView } from "../printer";

const HOUR_MS = 3_600_000;

/** The printer's state (supplies, alerts, page count); without a source (no printer configured) it answers `disabled`. */
export class PrinterService {
  private lastWake: number | null = null;

  constructor(
    private readonly source?: PrinterSource,
    /** The printerWakeHours setting: how old the last read may be before opening the app wakes the printer. */
    private readonly wakeHours: () => number | null = () => null,
    private readonly clock: () => number = Date.now,
  ) {}

  get(): Promise<PrinterView> {
    return this.source ? this.source.get() : Promise.resolve({ ...PRINTER_OFF });
  }

  /** A fresh state when the source can refresh (this wakes the printer), else the same as `get`. */
  refresh(): Promise<PrinterView> {
    this.lastWake = this.clock();
    return this.source?.refresh ? this.source.refresh() : this.get();
  }

  /**
   * Opening the app: a refresh when both the last read and the last wake attempt are older than the wake setting
   * (an attempt counts, so a printer that is switched off isn't tried on every open); otherwise, or with the setting
   * off or CUPS unreachable, the same as `get`.
   */
  async refreshIfStale(): Promise<PrinterView> {
    const hours = this.wakeHours();
    const v = await this.get();
    if (hours === null || v.disabled || v.error || !this.source?.refresh) return v;
    const last = Math.max(v.readAt ?? 0, this.lastWake ?? 0);
    return this.clock() - last > hours * HOUR_MS ? this.refresh() : v;
  }
}
