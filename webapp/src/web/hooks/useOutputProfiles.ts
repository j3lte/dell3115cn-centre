import { useQuery } from "@tanstack/react-query";
import { client, unwrap } from "../lib/client";
import { keys } from "../lib/query";
import type { OutputProfile } from "../types/api";

export const useOutputProfiles = () =>
  useQuery({ queryKey: keys.outputProfiles, queryFn: (): Promise<OutputProfile[]> => unwrap(client.api["output-profiles"].$get()) });
