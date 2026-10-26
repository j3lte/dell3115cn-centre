import { client, unwrap } from "../lib/client";
import { useScanMutation } from "./useScanMutation";

export const useCancel = () => useScanMutation((id: string) => unwrap(client.api.scans[":id"].cancel.$post({ param: { id } })));
