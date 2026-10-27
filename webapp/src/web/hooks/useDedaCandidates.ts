import { useQuery } from "@tanstack/react-query";
import { client, unwrap } from "../lib/client";
import { keys } from "../lib/query";
import type { DedaCandidate } from "../types/api";

/** History scans with pages that can be analysed; fetched while `enabled` (the picker is open), fresh each time. */
export const useDedaCandidates = (enabled: boolean) =>
  useQuery({
    queryKey: keys.dedaCandidates,
    queryFn: async (): Promise<DedaCandidate[]> => (await unwrap(client.api.analyse.deda.candidates.$get())).scans,
    enabled,
    staleTime: 0,
  });
