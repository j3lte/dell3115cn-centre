import { useEffect, useState } from "react";
import type { Settings } from "../../types/api";
import type { SaveSetting } from "../../types/ui";
import { Field } from "../form/Field";
import { CardTitle } from "../ui/CardTitle";
import { Toggle } from "../ui/Toggle";

type NumberKey = "cleanupDays" | "printerWakeHours";

export type ToggleNumberSettingProps = {
  settings: Settings;
  save: SaveSetting;
  /** A nullable whole-number setting: null is off. */
  setting: NumberKey;
  title: string;
  label: string;
  hint: string;
  fieldLabel: string;
  /** Used when it is switched on and the field is empty or invalid. */
  fallback: number;
  max?: number;
  /** Name in the "… saved" message. */
  what: string;
};

/** Settings card: a switch for a nullable number setting, and the number when it is on. */
export function ToggleNumberSetting({ settings, save, setting, title, label, hint, fieldLabel, fallback, max, what }: ToggleNumberSettingProps) {
  const current = settings[setting];
  const [value, setValue] = useState(String(fallback));
  useEffect(() => {
    if (current) setValue(String(current));
  }, [current]);
  const number = () => Math.max(1, Math.round(Number(value)) || fallback);
  return (
    <section className="card">
      <CardTitle>{title}</CardTitle>
      <Toggle label={label} hint={hint} checked={current !== null} onChange={(on) => save({ [setting]: on ? number() : null }, what)} />
      {current !== null && (
        <form
          className="flex flex-wrap items-end gap-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            void save({ [setting]: number() }, what);
          }}
        >
          <Field label={fieldLabel} className="flex-1 basis-40">
            <input className="control" type="number" min={1} max={max} inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
          <button className="btn" type="submit" disabled={String(current) === value}>
            Save
          </button>
        </form>
      )}
    </section>
  );
}
