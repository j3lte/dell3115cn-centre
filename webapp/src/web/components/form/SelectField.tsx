import type { ReactNode } from "react";
import { Field } from "./Field";

/** A labelled `<select>`; `onChange` gets the chosen option's value as the DOM gives it (a string). */
export function SelectField<T extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled,
  className,
}: {
  label: ReactNode;
  value: T;
  options: readonly (readonly [T, ReactNode])[];
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Field label={label} className={className}>
      <select className="control" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </Field>
  );
}
