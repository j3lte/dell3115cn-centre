import * as SwitchPrimitive from "@radix-ui/react-switch";
import { useId, type ReactNode } from "react";

/** Labelled on/off switch (Radix Switch), the whole row is the touch target. */
export function Toggle({
  label,
  checked,
  onChange,
  disabled,
  hint,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex min-h-tap items-center gap-3">
      <SwitchPrimitive.Root
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        className="relative h-7 w-12 flex-none cursor-pointer rounded-full border border-line bg-surface-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-accent data-[state=checked]:bg-accent"
      >
        <SwitchPrimitive.Thumb className="block size-[22px] translate-x-[2px] rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[22px]" />
      </SwitchPrimitive.Root>
      <label htmlFor={id} className="flex cursor-pointer flex-col">
        <span>{label}</span>
        {hint && <small className="text-muted">{hint}</small>}
      </label>
    </div>
  );
}
