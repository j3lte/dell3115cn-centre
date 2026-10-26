import { useEffect, useState } from "react";
import type { Settings } from "../../types/api";
import type { SaveSetting } from "../../types/ui";
import { Field } from "../form/Field";
import { CardTitle } from "../ui/CardTitle";
import { Toggle } from "../ui/Toggle";

/** Settings card: delete old scans automatically, after a number of days. */
export function CleanupSetting({ settings, save }: { settings: Settings; save: SaveSetting }) {
  const [days, setDays] = useState("30");
  useEffect(() => {
    if (settings.cleanupDays) setDays(String(settings.cleanupDays));
  }, [settings.cleanupDays]);
  return (
    <section className="card">
      <CardTitle>History cleanup</CardTitle>
      <Toggle
        label="Delete old scans automatically"
        hint="Failed deliveries are deleted too once they are this old."
        checked={settings.cleanupDays !== null}
        onChange={(on) => save({ cleanupDays: on ? Math.max(1, Number(days) || 30) : null }, "Cleanup")}
      />
      {settings.cleanupDays !== null && (
        <form
          className="flex flex-wrap items-end gap-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            void save({ cleanupDays: Math.max(1, Math.round(Number(days)) || 30) }, "Cleanup");
          }}
        >
          <Field label="Delete scans older than (days)" className="flex-1 basis-40">
            <input className="control" type="number" min={1} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
          <button className="btn" type="submit" disabled={String(settings.cleanupDays) === days}>
            Save
          </button>
        </form>
      )}
    </section>
  );
}
