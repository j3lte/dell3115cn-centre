import { useMutation, useQueryClient } from "@tanstack/react-query";
import { applyScan } from "../lib/cache";
import type { ScanView } from "../types/api";

/** A mutation whose answer is the scan's new view, which goes into the cache. Only the scan mutation hooks use it. */
export function useScanMutation<A>(fn: (a: A) => Promise<ScanView>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: (v) => applyScan(qc, v) });
}
