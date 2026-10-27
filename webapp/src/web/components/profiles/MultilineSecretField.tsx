import { MASK, type FieldSpec } from "../../helpers/profiles";
import { Field } from "../form/Field";

/** A secret pasted as several lines (an SSH private key). A stored one arrives as `MASK` and shows as an empty field. */
export function MultilineSecretField({ spec, value, onChange }: { spec: FieldSpec; value: unknown; onChange: (v: unknown) => void }) {
  const stored = value === MASK;
  return (
    <div className="field">
      <Field label={spec.label}>
        <textarea
          className="control font-mono text-xs"
          rows={4}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder={stored ? "Saved — paste to replace" : spec.placeholder}
          value={stored || typeof value !== "string" ? "" : value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) => {
            if (stored && e.target.value === "") onChange(MASK);
          }}
        />
      </Field>
      {spec.hint && <small className="text-muted">{spec.hint}</small>}
      {stored && <small className="text-muted">A value is saved. Leave empty to keep it.</small>}
    </div>
  );
}
