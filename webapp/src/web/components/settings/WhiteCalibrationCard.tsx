import { useState } from "react";
import { errorText } from "../../lib/errors";
import type { Settings } from "../../types/api";
import { formatWhenShort } from "../../helpers/format";
import { calibrationSummary } from "../../helpers/settings";
import { useCalibrateWhite } from "../../hooks/useCalibrateWhite";
import { useClearWhite } from "../../hooks/useClearWhite";
import { CardTitle } from "../ui/CardTitle";

const SOURCES = [
  { source: "flatbed", label: "Flatbed", hint: "A plain white A4 sheet in the top-left corner of the glass, lid closed." },
  { source: "adf", label: "Feeder", hint: "One plain white A4 sheet in the feeder." },
] as const;

/** Settings card: white-point calibration per source, so white paper comes out neutral in colour scans. */
export function WhiteCalibrationCard({ settings }: { settings: Settings }) {
  const calibrate = useCalibrateWhite();
  const clear = useClearWhite();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const run = async (source: "flatbed" | "adf", action: "calibrate" | "reset") => {
    setBusy(source);
    setError(undefined);
    try {
      if (action === "calibrate") await calibrate.mutateAsync(source);
      else await clear.mutateAsync(source);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="card">
      <CardTitle>Colour calibration</CardTitle>
      <p className="hint m-0">
        Makes white paper come out neutral in colour scans: the app scans a white sheet and corrects every colour scan from
        that source by the same amount. Gray and black-and-white scans are not affected.
      </p>
      {error && (
        <p className="msg msg-error m-0" role="alert">
          {error}
        </p>
      )}
      {SOURCES.map(({ source, label, hint }) => {
        const cal = settings.whiteBalance?.[source];
        return (
          <div key={source} className="flex flex-col gap-2 rounded-xl border border-line p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="m-0 font-semibold">{label}</p>
                <p className="hint m-0">{cal ? `Calibrated ${formatWhenShort(cal.at)}: ${calibrationSummary(cal)}` : "Not calibrated"}</p>
              </div>
              <div className="flex gap-2">
                {cal && (
                  <button className="btn btn-sm" type="button" disabled={busy !== null} onClick={() => run(source, "reset")}>
                    Reset
                  </button>
                )}
                <button className="btn btn-sm btn-primary" type="button" disabled={busy !== null} onClick={() => run(source, "calibrate")}>
                  {busy === source ? "Scanning white…" : "Calibrate"}
                </button>
              </div>
            </div>
            <p className="hint m-0">{hint}</p>
          </div>
        );
      })}
    </section>
  );
}
