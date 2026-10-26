import { useQuery } from "@tanstack/react-query";
import { client, unwrap } from "../lib/client";
import { keys } from "../lib/query";
import type { Settings } from "../types/api";

export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: (): Promise<Settings> => unwrap(client.api.settings.$get()) });
