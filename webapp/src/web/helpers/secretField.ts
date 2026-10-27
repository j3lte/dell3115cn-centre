import { MASK, type FieldSpec } from "./profiles";

/**
 * The mask rules of a destination field: a stored secret arrives as `MASK`, shows as an empty field with a "saved"
 * placeholder and note, and leaving it untouched keeps it. Other fields show their value as is.
 */
export function secretField(spec: FieldSpec, value: unknown, onChange: (v: unknown) => void) {
  const stored = spec.kind === "secret" && value === MASK;
  return {
    value: stored || value === undefined || value === null ? "" : String(value),
    placeholder: stored ? (spec.multiline ? "Saved — paste to replace" : "Saved — type to replace") : spec.placeholder,
    savedNote: stored ? "A value is saved. Leave empty to keep it." : null,
    onBlur: (e: { target: { value: string } }) => {
      if (stored && e.target.value === "") onChange(MASK);
    },
  };
}
