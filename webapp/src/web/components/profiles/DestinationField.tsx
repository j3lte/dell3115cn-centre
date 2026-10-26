import { MASK, type FieldSpec } from "../../helpers/profiles";
import { Field } from "../form/Field";
import { Toggle } from "../ui/Toggle";

/** One setting of an output profile's destination. A stored secret arrives as `MASK` and shows as an empty field. */
export function DestinationField({ spec, value, onChange }: { spec: FieldSpec; value: unknown; onChange: (v: unknown) => void }) {
  if (spec.kind === "bool") return <Toggle label={spec.label} checked={value === true} onChange={onChange} />;
  const isSecret = spec.kind === "secret";
  const stored = isSecret && value === MASK;
  return (
    <div className="field">
      <Field label={spec.label}>
        <input
          className="control"
          type={isSecret ? "password" : spec.kind === "number" ? "number" : spec.kind === "url" ? "url" : "text"}
          inputMode={spec.kind === "number" ? "numeric" : undefined}
          autoComplete={isSecret ? "new-password" : "off"}
          autoCapitalize="off"
          spellCheck={false}
          placeholder={stored ? "Saved — type to replace" : spec.placeholder}
          value={stored ? "" : value === undefined || value === null ? "" : String(value)}
          onChange={(e) => onChange(spec.kind === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value)}
          onBlur={(e) => {
            // Leaving a stored secret untouched keeps it.
            if (stored && e.target.value === "") onChange(MASK);
          }}
        />
      </Field>
      {spec.hint && <small className="text-muted">{spec.hint}</small>}
      {stored && <small className="text-muted">A value is saved. Leave empty to keep it.</small>}
    </div>
  );
}
