import { useMutation, useQueryClient } from "@tanstack/react-query";
import { afterProfileChange } from "../lib/cache";
import { client, unwrap } from "../lib/client";
import type { InputProfile, InputProfileDraft } from "../types/api";

/** Save = `POST` for a profile without an id, `PUT /{id}` with one. */
export function useSaveInputProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: InputProfileDraft): Promise<InputProfile> =>
      p.id
        ? unwrap(client.api["input-profiles"][":id"].$put({ param: { id: String(p.id) }, json: p }))
        : unwrap(client.api["input-profiles"].$post({ json: p })),
    onSuccess: () => afterProfileChange(qc, "input"),
  });
}
