import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseThemeChoice, resolveTheme, THEME_COLOR, THEME_KEY } from "../../src/web/helpers/theme";

test("parseThemeChoice: system unless light or dark was chosen", () => {
  expect(parseThemeChoice("light")).toBe("light");
  expect(parseThemeChoice("dark")).toBe("dark");
  expect(parseThemeChoice("system")).toBe("system");
  expect(parseThemeChoice(null)).toBe("system");
  expect(parseThemeChoice("purple")).toBe("system");
});

test("resolveTheme: an explicit choice wins over the system", () => {
  expect(resolveTheme("system", true)).toBe("dark");
  expect(resolveTheme("system", false)).toBe("light");
  expect(resolveTheme("light", true)).toBe("light");
  expect(resolveTheme("dark", false)).toBe("dark");
});

test("index.html sets the theme before the first paint, with the same key and colours", () => {
  const html = readFileSync(join(import.meta.dir, "../../src/web/index.html"), "utf8");
  const head = html.slice(0, html.indexOf("</head>"));
  expect(head).toContain(`localStorage.getItem("${THEME_KEY}")`);
  expect(head).toContain("dataset.theme");
  expect(head).toContain(THEME_COLOR.dark);
  const css = readFileSync(join(import.meta.dir, "../../src/web/styles.css"), "utf8");
  expect(css).toContain(':root[data-theme="dark"]');
  expect(css).not.toContain("@media (prefers-color-scheme: dark)");
});
