import { useMutation, useQueryClient } from "@tanstack/react-query";
import { afterSettings } from "../lib/cache";
import { client, unwrap } from "../lib/client";
import type { AppSettings, Settings } from "../types/api";

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<AppSettings> | Record<string, unknown>): Promise<Settings> => unwrap(client.api.settings.$put({ json: patch })),
    onSuccess: (v) => afterSettings(qc, v),
  });
}
