import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { client, unwrap } from "../lib/client";
import { keys } from "../lib/query";
import type { PrinterView } from "../types/api";
import type { Printer } from "../types/ui";

/**
 * The printer's state from the CUPS queue, polled once a minute (the server caches it for as long). `check` asks for a
 * fresh state now: it wakes the printer (no page is printed) and takes a few seconds.
 */
export function usePrinter(): Printer {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: keys.printer,
    queryFn: (): Promise<PrinterView> => unwrap(client.api.printer.$get()),
    refetchInterval: 60_000,
    refetchIntervalInBackground: true, // keeps polling in a hidden tab, like the old timer
  });
  const refresh = useMutation({
    mutationFn: (): Promise<PrinterView> => unwrap(client.api.printer.refresh.$post()),
    onSuccess: (v) => queryClient.setQueryData(keys.printer, v),
  });
  const { mutateAsync } = refresh;
  const check = useCallback(
    () =>
      mutateAsync().then(
        () => {},
        () => {}, // the regular poll shows the error state
      ),
    [mutateAsync],
  );
  return { view: data ?? null, checking: refresh.isPending, check };
}
