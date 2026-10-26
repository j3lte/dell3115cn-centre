import { useState } from "react";
import { cx, formatWhen, plural } from "../../helpers/format";
import { inTray } from "../../helpers/live";
import { downloadFirst, historySend, isActive, outputChoices, scanSettingsSummary } from "../../helpers/scan";
import { useDeleteScan } from "../../hooks/useDeleteScan";
import { useResend } from "../../hooks/useResend";
import { useSend } from "../../hooks/useSend";
import { errorText } from "../../lib/errors";
import type { OutputProfile, ScanView } from "../../types/api";
import { ErrorMessage } from "../form/ErrorMessage";
import { DownloadList } from "../scan/DownloadList";
import { PageStrip } from "../scan/PageStrip";
import { PageViewer } from "../scan/PageViewer";
import { ProblemLine } from "../scan/ProblemLine";
import { Confirm } from "../ui/Confirm";
import { StatusBadges } from "./StatusBadges";

/** One scan in full: status, pages, deliveries (with their files), and sending again, downloading or deleting it. */
export function ScanDetail({
  scan,
  outputs,
  desktop,
  onUpdate,
  onDeleted,
}: {
  scan: ScanView;
  outputs: readonly OutputProfile[];
  desktop: boolean;
  onUpdate: (v: ScanView) => void;
  onDeleted: (id: string) => void;
}) {
  const [target, setTarget] = useState<number | undefined>(scan.outputProfileId ?? undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirm, setConfirm] = useState(false);
  const send = useSend();
  const resend = useResend();
  const deleteScan = useDeleteScan();
  const mode = historySend(scan);
  const canResend = mode === "resend";
  // Assistant scans that were never sent: send them with any output profile (a Download profile gives a file).
  const canSend = mode === "send";
  const firstSend = canSend || scan.deliveries.length === 0;

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="card">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="m-0 flex-1 text-xl font-bold">{formatWhen(scan.createdAt)}</h2>
          <StatusBadges scan={scan} outputs={outputs} />
        </div>
        <p className="m-0 text-muted">
          {plural(scan.pages.length, "page")} · {scan.inputProfile.name} →{" "}
          {scan.outputProfileName ?? (scan.outputProfileId === null ? "not sent" : "deleted profile")}
        </p>
        <p className="m-0 text-sm text-muted">{scanSettingsSummary(scan.inputProfile, scan.area)}</p>
        <ProblemLine problem={scan.problem} />
        {scan.error && <p className="msg msg-error">{scan.error}</p>}
        {inTray(scan) && (
          <div className="flex flex-wrap items-center gap-2.5">
            <p className="hint m-0 flex-1">This scan is in the review tray and has not been sent.</p>
            <a href={`#/scan/${encodeURIComponent(scan.id)}`} className="btn btn-primary">
              Open in review
            </a>
          </div>
        )}
      </div>

      {scan.pages.length > 0 && (desktop ? <div className="card h-[min(56dvh,640px)]"><PageViewer scan={scan} /></div> : <div className="card"><PageStrip scan={scan} /></div>)}

      <div className="card">
        <h3 className="m-0 text-base font-bold">Deliveries</h3>
        {scan.deliveries.length === 0 && <p className="hint">Not delivered.</p>}
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {[...scan.deliveries].reverse().map((d) => (
            <li key={d.id} className="flex flex-col gap-1.5 rounded-xl border border-line p-3">
              <div className="flex flex-wrap items-center gap-2">
                <strong className="flex-1">{d.outputProfileName}</strong>
                <span className={cx("badge", d.status === "sent" ? "badge-ok" : d.status === "failed" ? "badge-error" : "badge-busy")}>{d.status}</span>
              </div>
              <small className="text-muted">{formatWhen(d.createdAt)}</small>
              {d.error && <p className="msg msg-error text-sm">{d.error}</p>}
              <DownloadList files={d.files} small />
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h3 className="m-0 text-base font-bold">{firstSend ? "Send or download" : "Send again"}</h3>
        <div className="flex flex-wrap gap-2.5">
          <select className="control min-w-0 flex-[2] basis-48" value={target ?? ""} onChange={(e) => setTarget(Number(e.target.value))} disabled={!(canResend || canSend) || busy} aria-label="Output profile">
            {outputChoices(downloadFirst(outputs), target).map(([value, name]) => (
              <option key={value} value={value}>
                {name}
              </option>
            ))}
          </select>
          <button
            className="btn btn-primary flex-1"
            disabled={!(canResend || canSend) || busy || target === undefined}
            onClick={() => act(async () => onUpdate(await (canSend ? send : resend).mutateAsync({ id: scan.id, outputProfileId: target! })))}
          >
            {busy ? "Sending…" : firstSend ? "Send" : "Resend"}
          </button>
        </div>
        {firstSend && (canSend || canResend) && <p className="hint">Choose a Download profile to get a file here, or any other profile to deliver it.</p>}
        {!canResend && !canSend && <p className="hint">Only finished or cancelled scans with pages can be sent.</p>}
        {error && <ErrorMessage>{error}</ErrorMessage>}
        <button className="btn btn-danger" disabled={busy || isActive(scan)} onClick={() => setConfirm(true)}>
          Delete scan
        </button>
        <Confirm
          open={confirm}
          onOpenChange={setConfirm}
          title="Delete this scan?"
          body="Its pages and files are removed from this app. Delivered copies stay where they were sent."
          confirmLabel="Delete"
          onConfirm={() =>
            act(async () => {
              await deleteScan.mutateAsync(scan.id);
              onDeleted(scan.id);
            })
          }
        />
      </div>
    </section>
  );
}
