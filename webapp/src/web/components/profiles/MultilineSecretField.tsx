import type { FieldSpec } from "../../helpers/profiles";
import { secretField } from "../../helpers/secretField";
import { Field } from "../form/Field";

/** A secret pasted as several lines (an SSH private key); mask rules: `secretField`. */
export function MultilineSecretField({ spec, value, onChange }: { spec: FieldSpec; value: unknown; onChange: (v: unknown) => void }) {
  const secret = secretField(spec, value, onChange);
  return (
    <div className="field">
      <Field label={spec.label}>
        <textarea
          className="control font-mono text-xs"
          rows={4}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder={secret.placeholder}
          value={secret.value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={secret.onBlur}
        />
      </Field>
      {spec.hint && <small className="text-muted">{spec.hint}</small>}
      {secret.savedNote && <small className="text-muted">{secret.savedNote}</small>}
    </div>
  );
}
