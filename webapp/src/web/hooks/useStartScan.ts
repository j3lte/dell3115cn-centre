import { client, unwrap } from "../lib/client";
import type { AreaMm } from "../types/api";
import { useScanMutation } from "./useScanMutation";

export const useStartScan = () =>
  useScanMutation((a: { inputProfileId: number; outputProfileId: number; review: boolean; areaMm?: AreaMm }) => unwrap(client.api.scans.$post({ json: a })));
