import * as SliderPrimitive from "@radix-ui/react-slider";

/** Labelled slider (Radix Slider) with the value shown. `onCommit` fires when the user lets go. */
export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  onCommit,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="field">
      <div className="flex justify-between">
        <span className="field-label">{label}</span>
        <output className="text-sm tabular-nums text-muted">{value}</output>
      </div>
      <SliderPrimitive.Root
        className="relative flex h-tap w-full touch-none items-center select-none data-[disabled]:opacity-50"
        value={[value]}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onValueChange={([v]) => onChange(v!)}
        onValueCommit={([v]) => onCommit?.(v!)}
      >
        <SliderPrimitive.Track className="relative h-1.5 grow rounded-full bg-surface-2">
          <SliderPrimitive.Range className="absolute h-full rounded-full bg-accent" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
          aria-label={label}
          className="block size-6 cursor-grab rounded-full border-2 border-accent bg-surface shadow focus-visible:outline-3 focus-visible:outline-accent"
        />
      </SliderPrimitive.Root>
    </div>
  );
}
