import type { ReactNode } from "react";

/** Placeholder card for an empty detail pane ("Select a scan…"). */
export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="card items-center justify-center py-16 text-center text-muted">{children}</div>;
}
