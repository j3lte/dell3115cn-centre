import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../destinations/types";
import { pnmToPng } from "../pipeline/pnm";
import { measureWhite, whiteGains, type WhiteCalibration } from "../pipeline/white";
import type { Source } from "../profiles";
import type { JobEvent, ScanRequest, ScannerClient } from "../scanner-client";
import { StateError } from "./errors";
import type { SettingsService } from "./settings-service";

/** Flatbed white calibration: a 40 × 40 mm patch in the middle of the glass, inside an A4 sheet laid in the corner. */
const WHITE_PATCH_MM: [number, number, number, number] = [88, 128, 40, 40];

/** White-point calibration per source: the gains are stored in the settings and applied to colour pages. */
export class CalibrationService {
  constructor(
    private readonly settings: SettingsService,
    private readonly client: ScannerClient,
    private readonly clock: () => number = Date.now,
  ) {}

  gains(source: Source): [number, number, number] | undefined {
    return this.settings.read().whiteBalance[source]?.gains;
  }

  /**
   * Scans plain white paper (flatbed: a patch in the middle of the glass; feeder: one A4 sheet at 75 dpi) through the
   * normal colour pipeline without correction, and stores the gains that make it neutral for that source. Nothing
   * appears in History. Throws ValidationError when the paper isn't white or even, and keeps the old calibration.
   */
  async calibrate(source: Source): Promise<WhiteCalibration> {
    const req: ScanRequest =
      source === "flatbed"
        ? { source, mode: "color", dpi: 150, area_mm: WHITE_PATCH_MM }
        : { source, mode: "color", dpi: 75, paper: "a4" };
    const jobId = await this.client.startScan(req);
    const work = mkdtempSync(join(tmpdir(), "scan-white-"));
    try {
      let result: Extract<JobEvent, { type: "done" }> | null = null;
      for await (const ev of this.client.jobEvents(jobId)) if (ev.type === "done") result = ev;
      if (!result || result.pages < 1) throw new StateError(result?.message || "The calibration scan produced no image");
      const out = join(work, "white.png");
      await pnmToPng(await this.client.fetchPage(jobId, 1), "color", out);
      const m = await measureWhite(out);
      if (!m.even) throw new ValidationError("The white patch is uneven: use a clean, plain white sheet that covers the middle of the glass");
      const cal: WhiteCalibration = { gains: whiteGains(m.mean), white: m.mean.map((v) => Math.round(v * 10) / 10) as WhiteCalibration["white"], at: this.clock() };
      this.settings.setWhiteBalance(source, cal);
      return cal;
    } finally {
      await this.client.deleteJob(jobId).catch(() => {});
      rmSync(work, { recursive: true, force: true });
    }
  }

  clear(source: Source): void {
    this.settings.setWhiteBalance(source, null);
  }
}
