import type { ScanView } from "../../types/api";
import { formatWhenShort, plural } from "../../helpers/format";

/** Other scans waiting in the review tray; each opens in the tray ("#/scan/<id>"). */
export function PendingReview({ scans }: { scans: ScanView[] }) {
  if (!scans.length) return null;
  return (
    <details className="card gap-2 border-busy/40 py-3" open={scans.length === 1}>
      <summary className="min-h-tap cursor-pointer content-center font-semibold">
        Pending review ({scans.length}) <span className="font-normal text-muted">· not sent yet</span>
      </summary>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {scans.map((s) => (
          <li key={s.id}>
            <a href={`#/scan/${encodeURIComponent(s.id)}`} className="btn btn-sm w-full justify-between gap-2">
              <span className="min-w-0 truncate">
                {formatWhenShort(s.createdAt)} · {plural(s.pages.length, "page")} · {s.inputProfile.name}
              </span>
              <span className="text-accent">{s.status === "scanning" ? "Scanning…" : "Open"}</span>
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}
