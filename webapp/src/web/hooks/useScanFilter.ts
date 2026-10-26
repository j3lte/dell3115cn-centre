import { client, unwrap } from "../lib/client";
import type { Filter } from "../types/api";
import { useScanMutation } from "./useScanMutation";

/** The filter for all pages of a scan in review. */
export const useScanFilter = () => useScanMutation((a: { id: string; filter: Filter }) => unwrap(client.api.scans[":id"].filter.$put({ param: { id: a.id }, json: a.filter })));
