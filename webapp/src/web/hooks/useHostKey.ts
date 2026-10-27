import { useQuery } from "@tanstack/react-query";
import { client, unwrap } from "../lib/client";
import { ApiError } from "../lib/errors";
import { keys } from "../lib/query";

export type HostKey = { fingerprint: string; firstSeen: number };

/** The SFTP host key trusted for host:port; null while none is (a 404). */
export function useHostKey(host: string, port: number) {
  return useQuery({
    queryKey: keys.hostKey(host, port),
    queryFn: async (): Promise<HostKey | null> => {
      try {
        return await unwrap(client.api["host-keys"].$get({ query: { host, port: String(port) } }));
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    enabled: host !== "",
  });
}
