import { useMutation, useQueryClient } from "@tanstack/react-query";
import { applyDeda } from "../lib/cache";
import { client, unwrap } from "../lib/client";
import type { DedaView } from "../types/api";

/** Scans a page on the glass for a new analysis; the new (scanning) entry goes into the list. */
export function useDedaScan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (): Promise<DedaView> => unwrap(client.api.analyse.deda.scan.$post()),
    onSuccess: (v) => applyDeda(qc, v),
  });
}
