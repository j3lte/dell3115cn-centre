import { expect, test } from "bun:test";
import { cx, formatWhen, formatWhenShort, mm, plural } from "../../src/web/helpers/format";
import { BRAND_NAME, MODE_LABEL, PAPER_LABEL, SOURCE_LABEL } from "../../src/web/helpers/labels";

test("labels are shared", () => {
  expect(PAPER_LABEL.glass).toBe("Full glass");
  expect(SOURCE_LABEL.adf).toBe("Feeder");
  expect(MODE_LABEL.lineart).toBe("Black & white");
  expect(BRAND_NAME).toBe("Dell 3115CN");
});

test("format helpers", () => {
  expect(mm(150.25)).toBe("150.3");
  expect(mm(30)).toBe("30");
  expect(plural(1, "page")).toBe("1 page");
  expect(plural(2, "page")).toBe("2 pages");
  expect(plural(2, "copy", "copies")).toBe("2 copies");
  expect(cx("a", false, null, undefined, "b")).toBe("a b");
});

test("dates show day, month and time without the year; only History's adds the weekday", () => {
  const when = new Date(2026, 9, 26, 9, 5);
  const part = (o: Intl.DateTimeFormatOptions) => when.toLocaleString(undefined, o);
  const weekday = part({ weekday: "short" });
  for (const text of [formatWhen(when.getTime()), formatWhenShort(when.getTime())]) {
    expect(text).toContain("26");
    expect(text).toContain(part({ month: "short" }));
    expect(text).toContain("05");
    expect(text).not.toContain("2026");
  }
  expect(formatWhen(when.getTime())).toContain(weekday);
  expect(formatWhenShort(when.getTime())).not.toContain(weekday);
});
