import { useMutation, useQueryClient } from "@tanstack/react-query";
import { afterProfileChange } from "../lib/cache";
import { client, unwrap } from "../lib/client";

export function useDeleteInputProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number): Promise<void> => unwrap(client.api["input-profiles"][":id"].$delete({ param: { id: String(id) } })),
    onSuccess: () => afterProfileChange(qc, "input"),
  });
}
