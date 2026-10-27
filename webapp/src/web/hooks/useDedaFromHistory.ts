import { useMutation, useQueryClient } from "@tanstack/react-query";
import { applyDeda } from "../lib/cache";
import { client, unwrap } from "../lib/client";
import type { DedaView } from "../types/api";

/** Analyses a stored History page; the new (analysing) entry goes into the list. */
export function useDedaFromHistory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (json: { scanId: string; page: number }): Promise<DedaView> => unwrap(client.api.analyse.deda.$post({ json })),
    onSuccess: (v) => applyDeda(qc, v),
  });
}
