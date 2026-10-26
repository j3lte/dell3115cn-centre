import * as Dialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { cx } from "../../helpers/format";

/** Bottom sheet on phones, centred dialog on larger screens (Radix Dialog). */
export function Sheet({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content
          aria-describedby={undefined}
          className={cx(
            "fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col gap-3 overflow-y-auto rounded-t-2xl border border-line bg-surface p-4 pb-[max(16px,env(safe-area-inset-bottom))] shadow-xl",
            "md:inset-x-auto md:top-1/2 md:bottom-auto md:left-1/2 md:w-[min(92vw,560px)] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl",
          )}
        >
          <div className="flex min-h-tap items-center gap-2">
            <Dialog.Title className="m-0 flex-1 text-lg font-bold">{title}</Dialog.Title>
            <Dialog.Close className="icon-btn" aria-label="Close">
              ×
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
