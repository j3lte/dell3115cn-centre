import { useEffect, useRef } from "react";
import type { OutputProfile, ScanView } from "../types/api";
import { downloadFiles } from "../helpers/download";
import { isDownload, lastDelivery } from "../helpers/scan";
import { startedHere } from "../lib/storage";

/** Downloads the files of a Download delivery once, for scans started in this tab (`startedHere`). */
export function useAutoDownload(scan: ScanView | undefined, outputs: readonly OutputProfile[]): void {
  const downloaded = useRef(new Set<string>());
  useEffect(() => {
    if (!scan || scan.status !== "done" || downloaded.current.has(scan.id)) return;
    if (!startedHere.all().includes(scan.id)) return;
    const d = lastDelivery(scan);
    if (d?.status === "sent" && isDownload(scan, outputs, d.outputProfileId ?? undefined) && d.files.length) {
      downloaded.current.add(scan.id);
      startedHere.remove(scan.id);
      downloadFiles(d.files);
    }
  }, [scan, outputs]);
}
