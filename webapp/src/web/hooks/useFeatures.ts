import { useQuery } from "@tanstack/react-query";
import { client, unwrap } from "../lib/client";
import { keys } from "../lib/query";

/** Optional features of this deployment; all off until the server has answered, so nothing flashes in. */
export function useFeatures(): { analyse: boolean } {
  const { data } = useQuery({ queryKey: keys.features, queryFn: (): Promise<{ analyse: boolean }> => unwrap(client.api.features.$get()), staleTime: Infinity });
  return { analyse: data?.analyse ?? false };
}
