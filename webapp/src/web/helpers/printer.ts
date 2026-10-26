import type { PrinterView, Supply } from "../types/api";

/** Text for the header when the printer reports an error that blocks printing; warnings stay on the Printer tab. */
export function headerAlert(v: PrinterView | null): string | null {
  return v?.severity === "error" && v.alerts.length ? `Printer: ${v.alerts.join("; ")}` : null;
}

/** Marker on the Printer tab. */
export function navDot(v: PrinterView | null): "error" | "warning" | null {
  return v?.alerts.length ? v.severity : null;
}

export function supplyLabel(s: Supply): { name: string; value: string } {
  const name = s.name.replace(/ Toner$/, "");
  return { name: name.charAt(0) + name.slice(1).toLowerCase(), value: s.level === null ? "?" : `${s.level}%` };
}
