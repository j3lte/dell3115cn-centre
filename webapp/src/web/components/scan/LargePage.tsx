import type { ReactNode } from "react";
import type { ScanView } from "../../types/api";

/** One page shown large (filtered view image), with an optional toolbar and side panel. */
export function LargePage({ scan, n, children, footer }: { scan: ScanView; n: number; children?: ReactNode; footer?: ReactNode }) {
  const page = scan.pages.find((p) => p.n === n);
  if (!page) return null;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 xl:flex-row">
      <figure className="m-0 flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-2 rounded-xl bg-surface-2 p-3">
        <img
          key={page.viewUrl}
          src={page.viewUrl}
          alt={`Page ${n}`}
          className="paper max-h-[calc(100dvh-280px)] min-h-0 w-auto max-w-full object-contain shadow-md"
          style={{ aspectRatio: `${page.width} / ${page.height}` }}
        />
        <figcaption className="text-sm text-muted">
          Page {n} of {scan.pages.length} · {page.width} × {page.height} px
        </figcaption>
        {footer}
      </figure>
      {children}
    </div>
  );
}
