import { cx } from "../../helpers/format";

/**
 * Link to the Printer tab with the error that blocks printing.
 * `bar`: under the sticky top bar (phone and tablet). `panel`: block in the desktop sidebar.
 */
export function PrinterAlert({ text, variant }: { text: string; variant: "bar" | "panel" }) {
  return (
    <a
      href="#/printer"
      role="alert"
      className={cx(
        "flex items-center gap-2 bg-danger-soft font-semibold text-danger no-underline",
        variant === "bar" ? "border-b border-line px-4 py-2 md:px-6" : "rounded-xl border border-danger p-3",
      )}
    >
      <span className="size-3 flex-none rounded-full bg-danger" aria-hidden="true" />
      <span className="min-w-0 flex-1">{text}</span>
    </a>
  );
}
