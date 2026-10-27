import { useState } from "react";
import { useClearDeda } from "../../hooks/useClearDeda";
import { errorText } from "../../lib/errors";
import type { DedaView } from "../../types/api";
import { ErrorMessage } from "../form/ErrorMessage";
import { Confirm } from "../ui/Confirm";
import { EmptyState } from "../ui/EmptyState";
import { DedaItem } from "./DedaItem";

/** The analyses, newest scan first, and "Clear history" (after a confirmation). */
export function DedaList({ analyses }: { analyses: readonly DedaView[] }) {
  const [confirm, setConfirm] = useState(false);
  const clear = useClearDeda();
  if (analyses.length === 0) return <EmptyState>No analyses yet.</EmptyState>;
  return (
    <div className="flex flex-col gap-3">
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {analyses.map((a) => (
          <DedaItem key={a.id} analysis={a} />
        ))}
      </ul>
      {clear.error && <ErrorMessage>{errorText(clear.error)}</ErrorMessage>}
      <button className="btn btn-danger self-start" disabled={clear.isPending} onClick={() => setConfirm(true)}>
        Clear history
      </button>
      <Confirm
        open={confirm}
        onOpenChange={setConfirm}
        title="Clear the tracking-dot history?"
        body="Every analysis and its images are deleted. Scans in History stay."
        confirmLabel="Clear"
        onConfirm={() => clear.mutate()}
      />
    </div>
  );
}
