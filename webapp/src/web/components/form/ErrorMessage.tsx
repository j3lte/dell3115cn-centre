import type { ReactNode } from "react";

/** An error under a form or an action, announced to screen readers as it appears. */
export function ErrorMessage({ children }: { children: ReactNode }) {
  return (
    <p className="msg msg-error" role="alert">
      {children}
    </p>
  );
}
