import { useMutation } from "@tanstack/react-query";
import { client, unwrap } from "../lib/client";

export const useTestDestination = () =>
  useMutation({
    mutationFn: (a: { type: string; config: Record<string, unknown>; id?: number }): Promise<{ ok: true }> => unwrap(client.api.destinations.test.$post({ json: a })),
  });
