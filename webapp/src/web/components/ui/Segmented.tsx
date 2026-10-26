import * as ToggleGroup from "@radix-ui/react-toggle-group";

/** Labelled single choice as a row of chips (Radix ToggleGroup). */
export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <ToggleGroup.Root type="single" value={value} onValueChange={(v) => v && onChange(v as T)} aria-label={label} className="flex flex-wrap gap-2">
        {options.map(([v, l]) => (
          <ToggleGroup.Item key={v} value={v} className="chip min-h-tap px-4">
            {l}
          </ToggleGroup.Item>
        ))}
      </ToggleGroup.Root>
    </div>
  );
}
