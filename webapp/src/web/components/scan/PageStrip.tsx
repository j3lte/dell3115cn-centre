import type { ScanView } from "../../types/api";
import { PageThumb } from "./PageThumb";

/** Numbered thumbnails (the page count is the main safeguard against silent double feeds). */
export function PageStrip({ scan, selected, onSelect }: { scan: ScanView; selected?: number; onSelect?: (n: number) => void }) {
  if (!scan.pages.length) return null;
  return (
    <ol aria-label="Pages" className="m-0 flex list-none gap-2 overflow-x-auto p-1">
      {scan.pages.map((p) => (
        <PageThumb key={p.n} n={p.n} thumbUrl={p.thumbUrl} selected={selected === p.n} onSelect={onSelect} />
      ))}
    </ol>
  );
}
