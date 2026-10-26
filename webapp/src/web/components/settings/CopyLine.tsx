import { useCopy } from "../../hooks/useCopy";

/** A value in a selectable box with a Copy button (clipboard needs a secure context; otherwise the value stays selectable). */
export function CopyLine({ label, value }: { label: string; value: string }) {
  const [copied, copy] = useCopy(value);
  return (
    <div className="flex flex-col gap-1">
      <span className="field-label">{label}</span>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 rounded-lg bg-surface-2 px-3 py-2 font-mono text-sm break-all select-all">{value}</code>
        <button className="btn btn-sm" onClick={copy} aria-label={`Copy ${label}`}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
