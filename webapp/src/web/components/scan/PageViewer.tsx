import type { ScanView } from "../../types/api";
import { useSelectedPage } from "../../hooks/useSelectedPage";
import { LargePage } from "./LargePage";
import { PageStrip } from "./PageStrip";

/** Large page + filmstrip: the desktop stage while scanning and after a result. */
export function PageViewer({ scan }: { scan: ScanView }) {
  const [n, setN] = useSelectedPage(scan);
  if (!n) return null;
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <LargePage scan={scan} n={n} />
      <PageStrip scan={scan} selected={n} onSelect={setN} />
    </div>
  );
}
