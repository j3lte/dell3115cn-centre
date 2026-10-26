import { useCallback, useState } from "react";
import type { AreaMm } from "../types/api";
import { EmptyStage } from "../components/scan/EmptyStage";
import { PageViewer } from "../components/scan/PageViewer";
import { PendingReview } from "../components/scan/PendingReview";
import { PreviewRegion } from "../components/scan/PreviewRegion";
import { ReviewTray } from "../components/scan/ReviewTray";
import { ScanForm } from "../components/scan/ScanForm";
import { ScanResult } from "../components/scan/ScanResult";
import { connectionInfo, displayedScan, inTray, pendingReview } from "../helpers/live";
import { MEDIA } from "../helpers/media";
import { isActive } from "../helpers/scan";
import type { Live } from "../hooks/useLive";
import { useAutoDownload } from "../hooks/useAutoDownload";
import { useChosenScan } from "../hooks/useChosenScan";
import { useHashParts } from "../hooks/useHashParts";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { usePick } from "../hooks/usePick";
import { useScanStarter } from "../hooks/useScanStarter";
import { store } from "../lib/storage";
import { go } from "../lib/router";
import type { Profiles } from "../types/ui";

export function ScanPage({ live, profiles }: { live: Live; profiles: Profiles }) {
  const { inputs, outputs } = profiles;
  const [inputId, setInputId] = usePick("scan.input", inputs.map((p) => p.id));
  const [outputId, setOutputId] = usePick("scan.output", outputs.map((p) => p.id));
  const [review, setReview] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const desktop = useMediaQuery(MEDIA.lg);
  const [dismissed, setDismissed] = useState<string | null>(() => store.get("scan.dismissed"));

  const input = inputs.find((p) => p.id === inputId);
  const output = outputs.find((p) => p.id === outputId);
  const info = connectionInfo(live.state);
  // "#/scan/<id>": a scan the user picked (History → Open in review, or the pending list); otherwise the newest.
  const parts = useHashParts();
  const chosenId = parts[0] === "scan" ? parts[1] : undefined;
  const scan = displayedScan(live.state.scans, chosenId);
  const pending = pendingReview(live.state.scans, scan?.id);
  const busy = Object.values(live.state.scans).some(isActive);
  const starter = useScanStarter({ inputId: input?.id, outputId: output?.id, review, dispatch: live.dispatch, chosenId });
  useChosenScan(live.state.scans, chosenId, live.dispatch);
  useAutoDownload(scan, outputs);

  // Why the scanner can't take a scan now (also blocks the flatbed preview); `reason` adds the profile checks.
  const notReady = !info.ready ? info.text : busy ? "Wait until the current scan has finished" : null;
  let reason: string | null = notReady;
  if (!profiles.loaded) reason = "Loading profiles…";
  else if (!input || !output) reason = "Create an input and an output profile first (Profiles tab)";

  // Stable for the memoized ScanResult: the page re-renders on every socket message.
  const scanId = scan?.id;
  const dismiss = useCallback(() => {
    if (!scanId) return;
    setDismissed(scanId);
    store.set("scan.dismissed", scanId);
    if (chosenId) go("scan");
  }, [scanId, chosenId]);

  const startArea = async (area: AreaMm) => {
    await starter.startArea(area);
    setPreviewing(false);
  };

  const inReview = !!scan && inTray(scan);
  const showResult = scan && !inReview && (isActive(scan) || scan.id !== dismissed || scan.id === chosenId);

  const layout = "flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(320px,400px)_minmax(0,1fr)] lg:items-start lg:gap-6";
  const pendingList = <PendingReview scans={pending} />;

  if (inReview && scan) {
    return (
      <div className="flex flex-col gap-4">
        {(pending.length > 0 || chosenId === scan.id) && (
          <div className="flex flex-col gap-2 lg:flex-row lg:items-start">
            {chosenId === scan.id && (
              <a href="#/scan" className="btn self-start">
                ← Back
              </a>
            )}
            <div className="min-w-0 flex-1">{pendingList}</div>
          </div>
        )}
        <div className={layout}>
          <ReviewTray key={scan.id} scan={scan} outputs={outputs} scannerReady={info.ready ? null : info.text} onUpdate={(v) => live.dispatch({ type: "scan", scan: v })} />
        </div>
      </div>
    );
  }

  const preview = previewing && input?.source === "flatbed" && (
    <PreviewRegion disabledReason={notReady} onScanArea={startArea} onClose={() => setPreviewing(false)} />
  );

  return (
    <div className={layout}>
      <div className="flex flex-col gap-4">
        {pendingList}
        <ScanForm
          profiles={profiles}
          choice={{ input, output, review, setInputId, setOutputId, setReview }}
          starter={starter}
          reason={reason}
          noPaper={input?.source === "adf" && info.ready && !live.state.status.paperInFeeder}
          busy={busy}
          previewing={previewing}
          onPreviewingChange={setPreviewing}
        />
        {!desktop && preview}
        {showResult && <ScanResult key={scan.id} scan={scan} outputs={outputs} onDismiss={dismiss} showStrip={!desktop} />}
      </div>
      {desktop && (
        <div className="min-w-0">
          {preview ||
            (scan && scan.pages.length > 0 && (showResult || isActive(scan)) ? (
              <section className="card lg:sticky lg:top-6 lg:h-[calc(100dvh-3rem)]">
                <PageViewer scan={scan} />
              </section>
            ) : (
              <EmptyStage source={input?.source} />
            ))}
        </div>
      )}
    </div>
  );
}
