import { client, unwrap } from "../lib/client";
import type { Filter } from "../types/api";
import { useScanMutation } from "./useScanMutation";

type PageOp = { order?: number[]; rotate?: { n: number; degrees: number }; remove?: number; filter?: { n: number; filter: Filter | null } };

/** Rotate, remove, reorder or filter pages of a scan in review. */
export const usePages = () => useScanMutation((a: { id: string; op: PageOp }) => unwrap(client.api.scans[":id"].pages.$patch({ param: { id: a.id }, json: a.op })));
