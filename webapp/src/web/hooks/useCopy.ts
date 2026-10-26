import { useCallback, useEffect, useRef, useState } from "react";

/** Copies `value` to the clipboard; `copied` is true for 2 s after. Needs a secure context, else nothing happens. */
export function useCopy(value: string): [copied: boolean, copy: () => Promise<void>] {
  const [copied, setCopied] = useState(false);
  const reset = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(reset.current), []);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      clearTimeout(reset.current);
      reset.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard needs a secure context; the value stays selectable
    }
  }, [value]);
  return [copied, copy];
}
