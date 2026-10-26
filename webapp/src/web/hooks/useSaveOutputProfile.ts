import { useMutation, useQueryClient } from "@tanstack/react-query";
import { afterProfileChange } from "../lib/cache";
import { client, unwrap } from "../lib/client";
import type { OutputProfile, OutputProfileDraft } from "../types/api";

export function useSaveOutputProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: OutputProfileDraft): Promise<OutputProfile> =>
      p.id
        ? unwrap(client.api["output-profiles"][":id"].$put({ param: { id: String(p.id) }, json: p }))
        : unwrap(client.api["output-profiles"].$post({ json: p })),
    onSuccess: () => afterProfileChange(qc, "output"),
  });
}
