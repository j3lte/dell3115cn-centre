/**
 * Light/dark theme per device: System (default) follows the OS, Light and Dark override it. The choice lives in
 * localStorage; index.html applies it before the first paint (same key and colours), this module keeps it current.
 */
import { parseThemeChoice, resolveTheme, THEME_COLOR, THEME_KEY } from "../helpers/theme";
import type { ThemeChoice } from "../types/ui";
import { store } from "./storage";

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function getThemeChoice(): ThemeChoice {
  return parseThemeChoice(store.get(THEME_KEY));
}

function apply(): void {
  const theme = resolveTheme(getThemeChoice(), matchMedia(DARK_QUERY).matches);
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
}

export function setThemeChoice(choice: ThemeChoice): void {
  try {
    if (choice === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    // storage blocked (private mode): the choice lasts until the page reloads
    document.documentElement.dataset.theme = resolveTheme(choice, matchMedia(DARK_QUERY).matches);
    return;
  }
  apply();
}

/** Applies the stored choice and follows OS changes while the choice is System. */
export function initTheme(): void {
  apply();
  matchMedia(DARK_QUERY).addEventListener("change", apply);
}
