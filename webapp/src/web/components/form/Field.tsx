import type { ReactNode } from "react";
import { cx } from "../../helpers/format";

/** A control with its label above it; the label wraps the control, so the label is its accessible name. */
export function Field({ label, className, children }: { label: ReactNode; className?: string; children: ReactNode }) {
  return (
    <label className={cx("field", className)}>
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}
