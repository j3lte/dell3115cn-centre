import { useCallback, useState } from "react";
import { store } from "../lib/storage";

/** A choice among profile ids, remembered in localStorage; falls back to the first id when the remembered one is gone. */
export function usePick(key: string, ids: number[]): [number | undefined, (id: number) => void] {
  const [picked, setPicked] = useState<number | undefined>(() => Number(store.get(key)) || undefined);
  const valid = picked !== undefined && ids.includes(picked) ? picked : ids[0];
  const pick = useCallback(
    (id: number) => {
      setPicked(id);
      store.set(key, String(id));
    },
    [key],
  );
  return [valid, pick];
}
