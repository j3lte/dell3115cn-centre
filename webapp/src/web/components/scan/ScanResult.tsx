import { memo, useState } from "react";
import { errorText } from "../../lib/errors";
import type { OutputProfile, ScanView } from "../../types/api";
import { cx } from "../../helpers/format";
import { failedResend, isActive, shownDelivery, statusTitle } from "../../helpers/scan";
import { useCancel } from "../../hooks/useCancel";
import { useResend } from "../../hooks/useResend";
import { Spinner } from "../ui/Spinner";
import { DownloadList } from "./DownloadList";
import { PageStrip } from "./PageStrip";
import { ProblemLine } from "./ProblemLine";

const TONE_TEXT = { busy: "text-busy", ok: "text-ok", error: "text-danger", muted: "text-fg" };

/**
 * Result card for the newest scan: progress, outcome, problem, downloads. Memoized: the Scan page re-renders on every
 * socket message, and each progress message for this scan brings a new `scan` object.
 */
export const ScanResult = memo(function ScanResult({
  scan,
  outputs,
  onDismiss,
  showStrip = true,
}: {
  scan: ScanView;
  outputs: readonly OutputProfile[];
  onDismiss?: () => void;
  showStrip?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const cancel = useCancel();
  const resend = useResend();
  const d = shownDelivery(scan);
  const resendFailed = failedResend(scan);
  const { title, tone } = statusTitle(scan, outputs);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(undefined);
    try {
      await fn();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card result" aria-live="polite">
      <div className="flex min-h-tap items-center gap-2.5">
        {isActive(scan) && <Spinner />}
        <h2 className={cx("m-0 min-w-0 flex-1 text-lg font-bold", TONE_TEXT[tone])}>{title}</h2>
        {!isActive(scan) && onDismiss && (
          <button className="icon-btn" aria-label="Dismiss" onClick={onDismiss}>
            ×
          </button>
        )}
      </div>
      <ProblemLine problem={scan.problem} />
      {scan.status === "failed" && (d?.error || scan.error) && <p className="msg msg-error">{d?.error ?? scan.error}</p>}
      {resendFailed && (
        <p className="msg msg-error">
          Resend to {resendFailed.outputProfileName} failed: {resendFailed.error ?? "unknown error"}
        </p>
      )}
      {showStrip && <PageStrip scan={scan} />}
      {scan.status === "done" && d && <DownloadList files={d.files} downloadAll />}
      {err && <p className="msg msg-error">{err}</p>}
      {(scan.status === "scanning" || (scan.status === "failed" && scan.pages.length > 0)) && (
        <div className="flex flex-wrap gap-2.5">
          {scan.status === "scanning" && (
            <button className="btn flex-1" disabled={busy} onClick={() => act(() => cancel.mutateAsync(scan.id))}>
              Cancel
            </button>
          )}
          {scan.status === "failed" && scan.outputProfileId !== null && (
            <button className="btn btn-primary flex-1" disabled={busy} onClick={() => act(() => resend.mutateAsync({ id: scan.id, outputProfileId: scan.outputProfileId! }))}>
              {busy ? "Sending…" : "Try again"}
            </button>
          )}
        </div>
      )}
    </section>
  );
});
