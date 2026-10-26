import { useState, type ReactNode } from "react";
import { Confirm } from "../ui/Confirm";
import { ErrorMessage } from "../form/ErrorMessage";

/** A profile form's frame: title, fields, save state, Save and (after a confirm) Delete. */
export function FormShell({
  title,
  children,
  saving,
  error,
  ok,
  onSave,
  onDelete,
}: {
  title: string;
  children: ReactNode;
  saving: boolean;
  error?: string;
  ok?: string;
  onSave: () => void;
  onDelete?: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  return (
    <form
      className="card gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <h2 className="m-0 text-xl font-bold">{title}</h2>
      {children}
      {error && <ErrorMessage>{error}</ErrorMessage>}
      {ok && <p className="msg msg-ok">{ok}</p>}
      <div className="flex flex-wrap gap-2.5">
        <button type="submit" className="btn btn-primary min-w-32 flex-1" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        {onDelete && (
          <button type="button" className="btn btn-danger" onClick={() => setConfirm(true)}>
            Delete
          </button>
        )}
      </div>
      {onDelete && <Confirm open={confirm} onOpenChange={setConfirm} title="Delete this profile?" body="Scans in history keep their files." confirmLabel="Delete" onConfirm={onDelete} />}
    </form>
  );
}
