import { useCallback, useState } from "react";
import { errorText } from "../lib/errors";
import { go } from "../lib/router";
import { startedHere } from "../lib/storage";
import type { AreaMm, ScanView } from "../types/api";
import type { LiveAction } from "../types/ui";
import { useStartScan } from "./useStartScan";

/**
 * Starts scans from the Scan page with the chosen profiles: `start` (the Scan button: `starting`, `error`) and
 * `startArea` (a flatbed area from the preview, always reviewed; it throws, the preview shows the error). A started
 * scan goes into the live state and `startedHere`; a page showing a chosen scan goes back to the newest.
 */
export function useScanStarter({
  inputId,
  outputId,
  review,
  dispatch,
  chosenId,
}: {
  inputId: number | undefined;
  outputId: number | undefined;
  review: boolean;
  dispatch: (a: LiveAction) => void;
  chosenId?: string;
}) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();
  const { mutateAsync } = useStartScan();

  const started = useCallback(
    (v: ScanView) => {
      startedHere.add(v.id);
      dispatch({ type: "scan", scan: v });
    },
    [dispatch],
  );

  const start = useCallback(async () => {
    if (inputId === undefined || outputId === undefined) return;
    setStarting(true);
    setError(undefined);
    try {
      started(await mutateAsync({ inputProfileId: inputId, outputProfileId: outputId, review }));
      if (chosenId) go("scan");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setStarting(false);
    }
  }, [inputId, outputId, review, chosenId, mutateAsync, started]);

  const startArea = useCallback(
    async (area: AreaMm) => {
      if (inputId === undefined || outputId === undefined) return;
      started(await mutateAsync({ inputProfileId: inputId, outputProfileId: outputId, review: true, areaMm: area }));
      if (chosenId) go("scan");
    },
    [inputId, outputId, chosenId, mutateAsync, started],
  );

  return { starting, error, start, startArea };
}

export type ScanStarter = ReturnType<typeof useScanStarter>;
