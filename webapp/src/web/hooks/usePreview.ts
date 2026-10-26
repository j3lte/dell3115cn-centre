import { useMutation } from "@tanstack/react-query";
import { client, unwrapBlob } from "../lib/client";

/** A quick preview of the whole flatbed glass, as a PNG. */
export const usePreview = () => useMutation({ mutationFn: () => unwrapBlob(client.api.preview.$post()) });
