import { useMutation } from "@tanstack/react-query";
import { client, unwrap } from "../lib/client";

/** Deleting does not touch the cache: the caller leaves the scan's screen first, then `forgetScan`s it. */
export const useDeleteScan = () => useMutation({ mutationFn: (id: string): Promise<void> => unwrap(client.api.scans[":id"].$delete({ param: { id } })) });
