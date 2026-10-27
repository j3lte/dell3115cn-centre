import { useMutation, useQueryClient } from "@tanstack/react-query";
import { forgetDeda } from "../lib/cache";
import { client, unwrap } from "../lib/client";

/** Deletes an analysis and its images; it leaves the list. */
export function useDeleteDeda() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string): Promise<void> => unwrap(client.api.analyse.deda[":id"].$delete({ param: { id } })),
    onSuccess: (_, id) => forgetDeda(qc, id),
  });
}
