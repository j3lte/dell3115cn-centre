import { useEffect } from "react";
import type { LiveAction } from "../types/ui";
import type { ScanView } from "../types/api";
import { go } from "../lib/router";
import { useScan } from "./useScan";

/**
 * A scan chosen in the URL ("#/scan/<id>") that the live snapshot doesn't hold: fetches it and hands it to the live
 * state; a scan that is gone sends the page back to the newest ("#/scan").
 */
export function useChosenScan(scans: Record<string, ScanView>, chosenId: string | undefined, dispatch: (a: LiveAction) => void): void {
  const missing = useScan(chosenId && !scans[chosenId] ? chosenId : null);
  useEffect(() => {
    if (missing.data) dispatch({ type: "scan", scan: missing.data });
    else if (missing.isError) go("scan");
  }, [missing.data, missing.isError, dispatch]);
}
