import type { Settings } from "../../types/api";
import type { SaveSetting } from "../../types/ui";
import { ToggleNumberSetting } from "./ToggleNumberSetting";

/** Settings card: delete old scans automatically, after a number of days. */
export function CleanupSetting({ settings, save }: { settings: Settings; save: SaveSetting }) {
  return (
    <ToggleNumberSetting
      settings={settings}
      save={save}
      setting="cleanupDays"
      title="History cleanup"
      label="Delete old scans automatically"
      hint="Failed deliveries are deleted too once they are this old."
      fieldLabel="Delete scans older than (days)"
      fallback={30}
      what="Cleanup"
    />
  );
}
