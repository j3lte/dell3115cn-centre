import { useMutation, useQueryClient } from "@tanstack/react-query";
import { client, unwrap } from "../lib/client";
import { keys } from "../lib/query";

export function useClearWhite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (source: "flatbed" | "adf"): Promise<void> => unwrap(client.api.calibration.white[":source"].$delete({ param: { source } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.settings }),
  });
}
