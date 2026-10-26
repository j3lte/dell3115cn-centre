import { useState } from "react";
import { DEFAULT_FILTER, filterSummary } from "../../helpers/filter";
import { DPIS, MODE_LABEL, PAPER_LABEL, SOURCE_LABEL } from "../../helpers/labels";
import { NEW_INPUT, withMode } from "../../helpers/profiles";
import { useDeleteInputProfile } from "../../hooks/useDeleteInputProfile";
import { flashSaved, useSaveProfile } from "../../hooks/useSaveProfile";
import { useSaveInputProfile } from "../../hooks/useSaveInputProfile";
import { errorText } from "../../lib/errors";
import { go } from "../../lib/router";
import type { InputProfile, InputProfileDraft } from "../../types/api";
import { FilterPanel } from "../filter/FilterPanel";
import { Field } from "../form/Field";
import { SelectField } from "../form/SelectField";
import { Segmented } from "../ui/Segmented";
import { Slider } from "../ui/Slider";
import { Toggle } from "../ui/Toggle";
import { FormShell } from "./FormShell";

type Source = InputProfileDraft["source"];
type Mode = InputProfileDraft["mode"];
const SOURCE_OPTIONS = (Object.keys(SOURCE_LABEL) as Source[]).map((v): [Source, string] => [v, SOURCE_LABEL[v]]);
const MODE_OPTIONS = (Object.keys(MODE_LABEL) as Mode[]).map((v): [Mode, string] => [v, MODE_LABEL[v]]);
const DPI_OPTIONS = DPIS.map((v) => [v, `${v} dpi`] as const);
const FEEDER_PAPER = (["a4", "letter", "legal"] as const).map((v) => [v, PAPER_LABEL[v]] as const);
const FLATBED_PAPER = [["glass", PAPER_LABEL.glass]] as const;

/** Creates (`profile` null) or edits an input profile; the draft is local until saved. */
export function InputProfileForm({ profile }: { profile: InputProfile | null }) {
  const saveProfile = useSaveInputProfile();
  const deleteProfile = useDeleteInputProfile();
  const [d, setD] = useState<InputProfileDraft>(profile ?? NEW_INPUT);
  const set = (patch: Partial<InputProfileDraft>) => setD((x) => ({ ...x, ...patch }));
  const s = useSaveProfile(
    () => saveProfile.mutateAsync(d),
    (v) => {
      if (!profile) {
        flashSaved();
        go("profiles", "in", v.id);
      }
    },
  );
  const remove = async () => {
    try {
      await deleteProfile.mutateAsync(profile!.id);
      go("profiles");
    } catch (e) {
      s.setError(errorText(e));
    }
  };
  return (
    <FormShell title={profile ? `Input profile: ${profile.name}` : "New input profile"} saving={s.saving} error={s.error} ok={s.ok} onSave={s.run} onDelete={profile ? remove : undefined}>
      <Field label="Name">
        <input className="control" required value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="Letters (feeder, gray 300)" />
      </Field>
      <Segmented
        label="Source"
        value={d.source}
        options={SOURCE_OPTIONS}
        onChange={(source) => set({ source, paper: source === "flatbed" ? "glass" : d.paper === "glass" ? "a4" : d.paper })}
      />
      <Segmented
        label="Mode"
        value={d.mode}
        options={MODE_OPTIONS}
        onChange={(mode) => set(withMode(d, mode))}
      />
      <div className="flex flex-wrap gap-3">
        <SelectField className="flex-1 basis-36" label="Resolution" value={d.dpi} options={DPI_OPTIONS} onChange={(v) => set({ dpi: Number(v) as InputProfileDraft["dpi"] })} />
        <SelectField
          className="flex-1 basis-36"
          label="Paper size"
          value={d.paper}
          disabled={d.source === "flatbed"}
          options={d.source === "flatbed" ? FLATBED_PAPER : FEEDER_PAPER}
          onChange={(v) => set({ paper: v as InputProfileDraft["paper"] })}
        />
      </div>
      {d.mode === "lineart" && (
        <Slider label="Black-and-white threshold (lower keeps light text)" value={d.threshold} min={0} max={255} onChange={(threshold) => set({ threshold })} />
      )}
      {d.mode === "color" && (
        <Toggle
          label="16 bits per colour"
          hint="More tonal headroom for photos and editing, kept in PNG and TIFF; PDF and JPEG are 8-bit. Files are twice as large."
          checked={d.depth === 16}
          onChange={(on) => set({ depth: on ? 16 : undefined })}
        />
      )}
      <Toggle label="Turn pages upright automatically" hint="Pages with too little text are left as scanned." checked={d.autoOrient} onChange={(autoOrient) => set({ autoOrient })} />
      <details className="rounded-xl border border-line p-3">
        <summary className="flex min-h-tap cursor-pointer items-center justify-between font-semibold">
          <span>Default filter</span>
          <small className="font-normal text-muted">{filterSummary(d.filter ?? DEFAULT_FILTER)}</small>
        </summary>
        <div className="pt-2">
          <FilterPanel value={d.filter ?? DEFAULT_FILTER} onChange={(filter) => set({ filter })} />
        </div>
      </details>
    </FormShell>
  );
}
