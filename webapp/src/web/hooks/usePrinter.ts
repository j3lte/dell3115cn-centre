import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { client, unwrap } from "../lib/client";
import { keys } from "../lib/query";
import type { PrinterView } from "../types/api";
import type { Printer } from "../types/ui";

/**
 * The printer's state from the CUPS queue, polled once a minute (the server caches it for as long). `check` asks for a
 * fresh state now: it wakes the printer (no page is printed) and takes a few seconds. Opening the app (and coming back
 * to its tab) does the same, but only when the last read is older than the printerWakeHours setting.
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
    mutationFn: (ifStale: boolean): Promise<PrinterView> =>
      unwrap(client.api.printer.refresh.$post({ query: ifStale ? { ifStale: "true" } : {} })),
    onSuccess: (v) => queryClient.setQueryData(keys.printer, v),
  });
  const { mutate, mutateAsync } = refresh;
  useEffect(() => {
    const opened = () => {
      if (document.visibilityState === "visible") mutate(true);
    };
    opened();
    document.addEventListener("visibilitychange", opened);
    return () => document.removeEventListener("visibilitychange", opened);
  }, [mutate]);
  const check = useCallback(
    () =>
      mutateAsync(false).then(
        () => {},
        () => {}, // the regular poll shows the error state
      ),
    [mutateAsync],
  );
  return { view: data ?? null, checking: refresh.isPending, check };
}
