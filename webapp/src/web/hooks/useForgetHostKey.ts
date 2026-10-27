import { useMutation, useQueryClient } from "@tanstack/react-query";
import { client, unwrap } from "../lib/client";
import { keys } from "../lib/query";

/** Forgets the SFTP host key trusted for host:port: the next connection trusts the server's key again. */
export function useForgetHostKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { host: string; port: number }): Promise<void> => unwrap(client.api["host-keys"].$delete({ query: { host: a.host, port: String(a.port) } })),
    onSuccess: (_v, a) => qc.setQueryData(keys.hostKey(a.host, a.port), null),
  });
}
