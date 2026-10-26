import { useMutation, useQueryClient } from "@tanstack/react-query";
import { afterProfileChange } from "../lib/cache";
import { client, unwrap } from "../lib/client";

export function useDeleteOutputProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number): Promise<void> => unwrap(client.api["output-profiles"][":id"].$delete({ param: { id: String(id) } })),
    onSuccess: () => afterProfileChange(qc, "output"),
  });
}
