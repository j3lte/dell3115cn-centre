import { useCallback, useEffect, useRef, useState } from "react";
import type { ScanView } from "../types/api";

/** Which page is shown large: follows the newest page until the user picks one. */
export function useSelectedPage(scan: ScanView | undefined): [number | undefined, (n: number) => void] {
  const [picked, setPicked] = useState<{ scan: string; n: number } | null>(null);
  const count = scan?.pages.length ?? 0;
  const scanId = useRef(scan?.id);
  scanId.current = scan?.id;
  useEffect(() => {
    if (picked && scan && (picked.scan !== scan.id || picked.n > count)) setPicked(null);
  }, [scan?.id, count]); // eslint-disable-line react-hooks/exhaustive-deps
  const n = picked && scan && picked.scan === scan.id && picked.n <= count ? picked.n : count || undefined;
  const select = useCallback((k: number) => {
    if (scanId.current !== undefined) setPicked({ scan: scanId.current, n: k });
  }, []);
  return [n, select];
}
