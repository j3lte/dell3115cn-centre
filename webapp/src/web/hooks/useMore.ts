import { client, unwrap } from "../lib/client";
import { useScanMutation } from "./useScanMutation";

export const useMore = () => useScanMutation((id: string) => unwrap(client.api.scans[":id"].more.$post({ param: { id } })));
