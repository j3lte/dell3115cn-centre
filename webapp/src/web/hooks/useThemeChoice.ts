import { useCallback, useState } from "react";
import { getThemeChoice, setThemeChoice } from "../lib/theme";
import type { ThemeChoice } from "../types/ui";

export function useThemeChoice(): [ThemeChoice, (c: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(getThemeChoice);
  const set = useCallback((c: ThemeChoice) => {
    setThemeChoice(c);
    setChoice(c);
  }, []);
  return [choice, set];
}
