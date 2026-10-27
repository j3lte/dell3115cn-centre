import { useQuery } from "@tanstack/react-query";
import { dedaPoll } from "../helpers/deda";
import { client, unwrap } from "../lib/client";
import { keys } from "../lib/query";
import type { DedaView } from "../types/api";

/** Tracking-dot analyses, newest scan first; fetched again every 2 s while one is scanning or analysing. */
export const useDedaAnalyses = () =>
  useQuery({
    queryKey: keys.deda,
    queryFn: async (): Promise<DedaView[]> => (await unwrap(client.api.analyse.deda.$get())).analyses,
    refetchInterval: (q) => dedaPoll(q.state.data),
  });
