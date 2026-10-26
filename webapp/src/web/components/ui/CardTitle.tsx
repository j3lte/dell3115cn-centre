import type { ReactNode } from "react";
import { cx } from "../../helpers/format";

/** The heading of a card; `className` adds to its classes (a colour). */
export function CardTitle({ className, children }: { className?: string; children: ReactNode }) {
  return <h2 className={cx("m-0 text-lg font-bold", className)}>{children}</h2>;
}
