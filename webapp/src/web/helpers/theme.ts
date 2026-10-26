import type { Theme, ThemeChoice } from "../types/ui";

export const THEME_KEY = "theme";
/** Browser UI colour (meta theme-color) per theme: the page background. */
export const THEME_COLOR: Record<Theme, string> = { light: "#f4f2ee", dark: "#16181b" };

export function parseThemeChoice(v: string | null): ThemeChoice {
  return v === "light" || v === "dark" ? v : "system";
}

export function resolveTheme(choice: ThemeChoice, systemDark: boolean): Theme {
  return choice === "system" ? (systemDark ? "dark" : "light") : choice;
}
