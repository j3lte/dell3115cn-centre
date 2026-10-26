import { useMutation, useQueryClient } from "@tanstack/react-query";
import { client, unwrap } from "../lib/client";
import { keys } from "../lib/query";

export function useCalibrateWhite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (source: "flatbed" | "adf") => unwrap(client.api.calibration.white.$post({ json: { source } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.settings }),
  });
}
