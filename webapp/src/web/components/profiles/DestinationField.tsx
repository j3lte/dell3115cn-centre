import type { FieldSpec } from "../../helpers/profiles";
import { secretField } from "../../helpers/secretField";
import { Field } from "../form/Field";
import { Toggle } from "../ui/Toggle";
import { MultilineSecretField } from "./MultilineSecretField";

/** One setting of an output profile's destination (mask rules: `secretField`). */
export function DestinationField({ spec, value, onChange }: { spec: FieldSpec; value: unknown; onChange: (v: unknown) => void }) {
  const secret = secretField(spec, value, onChange);
  if (spec.kind === "bool") return <Toggle label={spec.label} checked={value === true} onChange={onChange} />;
  if (spec.multiline) return <MultilineSecretField spec={spec} value={value} onChange={onChange} />;
  const isSecret = spec.kind === "secret";
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
          placeholder={secret.placeholder}
          value={secret.value}
          onChange={(e) => onChange(spec.kind === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value)}
          onBlur={secret.onBlur}
        />
      </Field>
      {spec.hint && <small className="text-muted">{spec.hint}</small>}
      {secret.savedNote && <small className="text-muted">{secret.savedNote}</small>}
    </div>
  );
}
