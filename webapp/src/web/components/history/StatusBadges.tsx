import { cx } from "../../helpers/format";
import { statusBadges } from "../../helpers/scan";
import type { OutputProfile, ScanView } from "../../types/api";

/** A scan's status badges (sent, failed, …, and "partial" when it has a problem). */
export function StatusBadges({ scan, outputs }: { scan: ScanView; outputs: readonly OutputProfile[] }) {
  const b = statusBadges(scan, outputs);
  return (
    <span className="flex flex-wrap gap-1">
      {b.map(([t, c]) => (
        <span key={t} className={cx("badge", c)}>
          {t}
        </span>
      ))}
    </span>
  );
}
