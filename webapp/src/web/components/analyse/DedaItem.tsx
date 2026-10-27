import { memo, useState } from "react";
import { dedaPending, dedaSource } from "../../helpers/deda";
import { formatFull } from "../../helpers/format";
import { useDeleteDeda } from "../../hooks/useDeleteDeda";
import { useRenameDeda } from "../../hooks/useRenameDeda";
import { errorText } from "../../lib/errors";
import type { DedaView } from "../../types/api";
import { ErrorMessage } from "../form/ErrorMessage";
import { Spinner } from "../ui/Spinner";
import { DedaResult } from "./DedaResult";

/**
 * One analysis: its name (renamed in place), when it was scanned and from where, its progress or result, and Delete.
 * Memoized: a poll answer leaves unchanged entries as the same objects, so their items skip the re-render.
 */
export const DedaItem = memo(function DedaItem({ analysis: a }: { analysis: DedaView }) {
  const [draft, setDraft] = useState<string | null>(null);
  const rename = useRenameDeda();
  const del = useDeleteDeda();
  const name = a.name;
  const pending = dedaPending(a);
  const error = rename.error ?? del.error;

  const save = () => {
    const next = draft?.trim();
    if (!next || next === name) return setDraft(null);
    rename.mutate({ id: a.id, name: next }, { onSuccess: () => setDraft(null) });
  };

  return (
    <li className="card">
      <div className="flex flex-wrap items-center gap-2">
        {draft === null ? (
          <>
            <h2 className="m-0 min-w-0 flex-1 truncate text-lg font-bold">{name}</h2>
            <button className="btn btn-sm" onClick={() => setDraft(name)}>
              Rename
            </button>
          </>
        ) : (
          <form
            className="flex min-w-0 flex-1 gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <input
              className="control flex-1"
              aria-label="Name"
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setDraft(null)}
            />
            <button type="submit" className="btn btn-sm btn-primary" disabled={rename.isPending}>
              Save
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </form>
        )}
        <button className="btn btn-sm btn-danger" disabled={del.isPending} onClick={() => del.mutate(a.id)}>
          Delete
        </button>
      </div>
      <p className="hint">
        Scanned {formatFull(a.scannedAt)} · {dedaSource(a)}
      </p>
      {pending && (
        <p className="m-0 flex items-center gap-2 text-busy">
          <Spinner /> {a.status === "scanning" ? "Scanning…" : "Analysing…"}
        </p>
      )}
      <DedaResult analysis={a} />
      {error && <ErrorMessage>{errorText(error)}</ErrorMessage>}
    </li>
  );
});
