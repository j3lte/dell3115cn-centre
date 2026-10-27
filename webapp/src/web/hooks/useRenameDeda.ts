import { useMutation, useQueryClient } from "@tanstack/react-query";
import { applyDeda } from "../lib/cache";
import { client, unwrap } from "../lib/client";
import type { DedaView } from "../types/api";

/** Renames an analysis; the server's answer replaces the cached entry. */
export function useRenameDeda() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }): Promise<DedaView> => unwrap(client.api.analyse.deda[":id"].$patch({ param: { id }, json: { name } })),
    onSuccess: (v) => applyDeda(qc, v),
  });
}
