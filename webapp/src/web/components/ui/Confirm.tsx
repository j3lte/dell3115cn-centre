import type { ReactNode } from "react";
import { Sheet } from "./Sheet";

/** Confirmation dialog for destructive actions. */
export function Confirm({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={title}>
      <p className="m-0">{body}</p>
      <div className="flex flex-wrap gap-2.5">
        <button className="btn flex-1" onClick={() => onOpenChange(false)}>
          Keep
        </button>
        <button
          className="btn btn-danger flex-1"
          onClick={() => {
            onOpenChange(false);
            onConfirm();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </Sheet>
  );
}
