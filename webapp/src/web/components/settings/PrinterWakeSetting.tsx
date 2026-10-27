import { useEffect, useState } from "react";
import type { Settings } from "../../types/api";
import type { SaveSetting } from "../../types/ui";
import { Field } from "../form/Field";
import { CardTitle } from "../ui/CardTitle";
import { Toggle } from "../ui/Toggle";

const DEFAULT_HOURS = 24;
const hoursOf = (v: string) => Math.min(720, Math.max(1, Math.round(Number(v)) || DEFAULT_HOURS));

/** Settings card: opening the app wakes the sleeping printer to read its state, when the last read is this old. */
export function PrinterWakeSetting({ settings, save }: { settings: Settings; save: SaveSetting }) {
  const [hours, setHours] = useState(String(DEFAULT_HOURS));
  useEffect(() => {
    if (settings.printerWakeHours) setHours(String(settings.printerWakeHours));
  }, [settings.printerWakeHours]);
  return (
    <section className="card">
      <CardTitle>Printer</CardTitle>
      <Toggle
        label="Wake the printer when the app is opened"
        hint="A sleeping printer doesn't notice an opened cover or refilled paper. Waking it makes some noise; nothing is printed."
        checked={settings.printerWakeHours !== null}
        onChange={(on) => save({ printerWakeHours: on ? hoursOf(hours) : null }, "Printer wake-up")}
      />
      {settings.printerWakeHours !== null && (
        <form
          className="flex flex-wrap items-end gap-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            void save({ printerWakeHours: hoursOf(hours) }, "Printer wake-up");
          }}
        >
          <Field label="When the last check is older than (hours)" className="flex-1 basis-40">
            <input className="control" type="number" min={1} max={720} inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} />
          </Field>
          <button className="btn" type="submit" disabled={String(settings.printerWakeHours) === hours}>
            Save
          </button>
        </form>
      )}
    </section>
  );
}
