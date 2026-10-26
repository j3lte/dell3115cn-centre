import type { ReactNode } from "react";

/** Shared `<svg>` wrapper for the 24 x 24 stroke icons. */
export function Icon({ children, className = "size-6" }: { children: ReactNode; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={`${className} fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.8]`}>
      {children}
    </svg>
  );
}
