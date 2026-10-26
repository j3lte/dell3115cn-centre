import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { useEffect, useState } from "react";
import type { Filter } from "../../types/api";
import { PRESET_LABELS, SHARPEN_LABELS } from "../../helpers/labels";
import { Slider } from "../ui/Slider";
import { Toggle } from "../ui/Toggle";

/**
 * Filter editor: preset chips, brightness/contrast sliders, auto-crop and straighten, sharpening, threshold for
 * black-and-white.
 * Sliders save when released, so dragging doesn't re-render every page on every step.
 */
export function FilterPanel({ value, onChange, disabled }: { value: Filter; onChange: (f: Filter) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState(value);
  const key = JSON.stringify(value);
  useEffect(() => setDraft(value), [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = (f: Filter) => {
    setDraft(f);
    onChange(f);
  };
  const slider = (k: "brightness" | "contrast" | "threshold", label: string, min: number, max: number) => (
    <Slider
      label={label}
      value={draft[k]}
      min={min}
      max={max}
      step={k === "threshold" ? 1 : 5}
      disabled={disabled}
      onChange={(v) => setDraft({ ...draft, [k]: v })}
      onCommit={(v) => commit({ ...draft, [k]: v })}
    />
  );

  return (
    <div className="flex flex-col gap-2">
      <ToggleGroup.Root
        type="single"
        value={draft.preset}
        onValueChange={(p) => p && commit({ ...draft, preset: p as Filter["preset"] })}
        disabled={disabled}
        aria-label="Filter preset"
        className="flex flex-wrap gap-2"
      >
        {(Object.keys(PRESET_LABELS) as Filter["preset"][]).map((p) => (
          <ToggleGroup.Item key={p} value={p} className="chip">
            {PRESET_LABELS[p]}
          </ToggleGroup.Item>
        ))}
      </ToggleGroup.Root>
      {draft.preset === "bw" && slider("threshold", "Threshold", 0, 255)}
      {slider("brightness", "Brightness", -100, 100)}
      {slider("contrast", "Contrast", -100, 100)}
      <Toggle label="Auto-crop" hint="Trim the background around the document" checked={draft.autoCrop} disabled={disabled} onChange={(v) => commit({ ...draft, autoCrop: v })} />
      <Toggle label="Straighten" hint="Fix slightly skewed pages" checked={draft.deskew} disabled={disabled} onChange={(v) => commit({ ...draft, deskew: v })} />
      <div className="flex flex-col gap-1">
        <span>Sharpen</span>
        <ToggleGroup.Root
          type="single"
          value={draft.sharpen ?? "off"}
          onValueChange={(v) => v && commit({ ...draft, sharpen: v as NonNullable<Filter["sharpen"]> })}
          disabled={disabled}
          aria-label="Sharpen"
          className="flex flex-wrap gap-2"
        >
          {(Object.keys(SHARPEN_LABELS) as NonNullable<Filter["sharpen"]>[]).map((k) => (
            <ToggleGroup.Item key={k} value={k} className="chip">
              {SHARPEN_LABELS[k]}
            </ToggleGroup.Item>
          ))}
        </ToggleGroup.Root>
        <small className="text-muted">
          Undoes this scanner's measured blur: crisper small print and fine lines, nothing invented. Best at 300–600 dpi.
          Applied to the delivered files, not to the previews.
        </small>
      </div>
    </div>
  );
}
