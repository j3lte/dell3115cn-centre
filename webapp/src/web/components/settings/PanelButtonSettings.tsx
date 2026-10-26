import type { Settings } from "../../types/api";
import type { Profiles, SaveSetting } from "../../types/ui";
import { PANEL_FORMATS } from "../../helpers/settings";
import { SelectField } from "../form/SelectField";
import { CardTitle } from "../ui/CardTitle";

/** Settings card: which profiles the printer's Scan button uses (input profile, and an output profile per panel format). */
export function PanelButtonSettings({ settings, profiles, save }: { settings: Settings; profiles: Profiles; save: SaveSetting }) {
  const ids = settings.buttonOutputProfileIds ?? {};
  const outputs = profiles.outputs.map((p) => [p.id, p.name] as const);
  return (
    <section className="card">
      <CardTitle>Printer Scan button</CardTitle>
      <p className="hint">
        On the printer: Scan → Application → JPEG, TIFF or PDF. The scan starts with this input profile and the output profile chosen for that format,
        without review. Scans to a Download profile wait in History.
      </p>
      <SelectField
        label="Input profile"
        value={settings.buttonInputProfileId ?? ""}
        options={[["", "Not set (button does nothing)"], ...profiles.inputs.map((p) => [p.id, p.name] as const)]}
        onChange={(v) => save({ buttonInputProfileId: v ? Number(v) : null }, "Printer button")}
      />
      <div className="grid gap-3 md:grid-cols-3">
        {PANEL_FORMATS.map(([f, label]) => (
          <SelectField
            key={f}
            label={`Output for ${label}`}
            value={ids[f] ?? ""}
            options={[["", f === "pdf" ? "Not set" : "Same as PDF"], ...outputs]}
            onChange={(v) => save({ buttonOutputProfileIds: { [f]: v ? Number(v) : null } }, "Printer button")}
          />
        ))}
      </div>
    </section>
  );
}
