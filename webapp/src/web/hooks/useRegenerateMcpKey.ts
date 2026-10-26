import { useMutation, useQueryClient } from "@tanstack/react-query";
import { afterSettings } from "../lib/cache";
import { client, unwrap } from "../lib/client";
import type { Settings } from "../types/api";

export function useRegenerateMcpKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (): Promise<Settings> => unwrap(client.api.settings["mcp-key"].$post()),
    onSuccess: (v) => afterSettings(qc, v),
  });
}
