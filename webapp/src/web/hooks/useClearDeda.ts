import { useMutation, useQueryClient } from "@tanstack/react-query";
import { client, unwrap } from "../lib/client";
import { keys } from "../lib/query";
import type { DedaView } from "../types/api";

/** Deletes every analysis; the list is empty afterwards. */
export function useClearDeda() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<number> => (await unwrap(client.api.analyse.deda.$delete())).removed,
    onSuccess: () => qc.setQueryData<DedaView[]>(keys.deda, []),
  });
}
