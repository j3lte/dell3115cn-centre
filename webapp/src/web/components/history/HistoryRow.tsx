import { memo } from "react";
import { cx, formatWhen, plural } from "../../helpers/format";
import { shownDelivery } from "../../helpers/scan";
import type { OutputProfile, ScanView } from "../../types/api";
import { StatusBadges } from "./StatusBadges";

/**
 * One scan in the History list, linking to its detail. Memoized: a list re-render (a live message about another scan)
 * skips the rows whose scan, output profiles and selection are unchanged.
 */
export const HistoryRow = memo(function HistoryRow({ scan: s, outputs, active }: { scan: ScanView; outputs: readonly OutputProfile[]; active: boolean }) {
  return (
    <li>
      <a
        href={`#/history/${s.id}`}
        aria-current={active ? "true" : undefined}
        className={cx("card flex-row items-center gap-3 p-2.5 text-fg no-underline hover:border-accent", active && "border-accent bg-accent-soft")}
      >
        {s.pages[0] ? (
          <img src={s.pages[0].thumbUrl} alt="" loading="lazy" className="paper h-18 w-14 flex-none object-cover object-top" />
        ) : (
          <span className="paper grid h-18 w-14 flex-none place-items-center text-muted">–</span>
        )}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center justify-between gap-2">
            <strong className="truncate">{formatWhen(s.createdAt)}</strong>
            <span className="text-sm whitespace-nowrap text-muted">{plural(s.pages.length, "page")}</span>
          </span>
          <small className="truncate text-muted">
            {s.inputProfile.name} → {shownDelivery(s)?.outputProfileName ?? s.outputProfileName ?? (s.outputProfileId === null ? "not sent" : "?")}
          </small>
          <StatusBadges scan={s} outputs={outputs} />
        </span>
      </a>
    </li>
  );
});
