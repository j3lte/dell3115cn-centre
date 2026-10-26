import { useCallback, useRef, useState } from "react";
import { errorText } from "../lib/errors";

/** "Saved." survives the remount after a new profile gets its id (route /new → /<id>). */
let flash: string | undefined;

/** Call before navigating away from a just-created profile: the next `useSaveProfile` starts out saved. */
export function flashSaved(): void {
  flash = "Saved.";
}

export function useSaveProfile<T>(save: () => Promise<T>, after: (v: T) => Promise<void> | void) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [ok, setOk] = useState<string | undefined>(() => {
    const f = flash;
    flash = undefined;
    return f;
  });
  // `run` stays stable for memoized forms, yet calls the save and after of the last render.
  const latest = useRef({ save, after });
  latest.current = { save, after };
  const run = useCallback(async () => {
    setSaving(true);
    setError(undefined);
    setOk(undefined);
    try {
      const v = await latest.current.save();
      await latest.current.after(v);
      setOk("Saved.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }, []);
  return { saving, error, ok, run, setError };
}
