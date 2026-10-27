import { useQuery } from "@tanstack/react-query";
import { client, unwrap } from "../lib/client";
import { keys } from "../lib/query";

export type Features = { analyse: boolean; retiredDestinations: Record<string, string> };

const NONE: Record<string, string> = {};

/** Optional features of this deployment, and the destination types no longer offered; all off until the server has answered. */
export function useFeatures(): Features {
  const { data } = useQuery({ queryKey: keys.features, queryFn: (): Promise<Features> => unwrap(client.api.features.$get()), staleTime: Infinity });
  return { analyse: data?.analyse ?? false, retiredDestinations: data?.retiredDestinations ?? NONE };
}
