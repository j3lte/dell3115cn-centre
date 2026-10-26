/** A one-off notice from the server (e.g. a printer button press that could not start a scan), until dismissed. */
export function NoticeBar({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div role="alert" className="mx-4 mt-3 flex items-center gap-2 rounded-2xl border border-warn bg-warn-soft py-2 pr-2 pl-3.5 md:mx-6 lg:mx-8">
      <span className="flex-1">{message}</span>
      <button className="icon-btn" aria-label="Dismiss" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}
