import type { Settings } from "../../types/api";
import type { SaveSetting } from "../../types/ui";
import { ToggleNumberSetting } from "./ToggleNumberSetting";

/** Settings card: opening the app wakes the sleeping printer to read its state, when the last read is this old. */
export function PrinterWakeSetting({ settings, save }: { settings: Settings; save: SaveSetting }) {
  return (
    <ToggleNumberSetting
      settings={settings}
      save={save}
      setting="printerWakeHours"
      title="Printer wake-up"
      label="Wake the printer when the app is opened"
      hint="A sleeping printer doesn't notice an opened cover or refilled paper. Waking it makes some noise; nothing is printed."
      fieldLabel="When the last check is older than (hours)"
      fallback={24}
      max={720}
      what="Printer wake-up"
    />
  );
}
