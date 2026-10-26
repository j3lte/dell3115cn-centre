import { useMutation, useQueryClient } from "@tanstack/react-query";
import { afterProfileChange } from "../lib/cache";
import { client, unwrap } from "../lib/client";

/** Adds the missing common profiles; both lists may have changed. */
export function useAddCommonProfiles() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (): Promise<{ input: number; output: number }> => unwrap(client.api.profiles.common.$post()),
    onSuccess: (r) => Promise.all([r.input && afterProfileChange(qc, "input"), r.output && afterProfileChange(qc, "output")]),
  });
}
