import { useQuery } from "@tanstack/react-query";
import { client, unwrap } from "../lib/client";
import { keys } from "../lib/query";
import type { ScanView } from "../types/api";

/** One scan; `null` fetches nothing. */
export const useScan = (id: string | null) =>
  useQuery({
    queryKey: keys.scan(id ?? ""),
    queryFn: (): Promise<ScanView> => unwrap(client.api.scans[":id"].$get({ param: { id: id! } })),
    enabled: id !== null,
  });
