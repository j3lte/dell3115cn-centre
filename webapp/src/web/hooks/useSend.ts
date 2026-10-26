import { client, unwrap } from "../lib/client";
import { useScanMutation } from "./useScanMutation";

/** Send a scan in review (or a ready one); `outputProfileId` picks another output profile. */
export const useSend = () =>
  useScanMutation((a: { id: string; outputProfileId?: number }) => unwrap(client.api.scans[":id"].send.$post({ param: { id: a.id }, json: { outputProfileId: a.outputProfileId } })));
