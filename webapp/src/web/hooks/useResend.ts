import { client, unwrap } from "../lib/client";
import { useScanMutation } from "./useScanMutation";

export const useResend = () =>
  useScanMutation((a: { id: string; outputProfileId: number }) => unwrap(client.api.scans[":id"].resend.$post({ param: { id: a.id }, json: { outputProfileId: a.outputProfileId } })));
