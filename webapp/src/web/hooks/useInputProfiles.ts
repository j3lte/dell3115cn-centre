import { useQuery } from "@tanstack/react-query";
import { client, unwrap } from "../lib/client";
import { keys } from "../lib/query";
import type { InputProfile } from "../types/api";

export const useInputProfiles = () =>
  useQuery({ queryKey: keys.inputProfiles, queryFn: (): Promise<InputProfile[]> => unwrap(client.api["input-profiles"].$get()) });
