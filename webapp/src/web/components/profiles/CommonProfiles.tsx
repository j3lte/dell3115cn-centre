import { useState } from "react";
import { useAddCommonProfiles } from "../../hooks/useAddCommonProfiles";
import { errorText } from "../../lib/errors";
import { ErrorMessage } from "../form/ErrorMessage";
import { CardTitle } from "../ui/CardTitle";

/** Adds the built-in profiles that are missing and says how many it added. */
export function CommonProfiles() {
  const addCommon = useAddCommonProfiles();
  const [state, setState] = useState<{ busy: boolean; message?: string; error?: string }>({ busy: false });
  const add = async () => {
    setState({ busy: true });
    try {
      const r = await addCommon.mutateAsync();
      const total = r.input + r.output;
      setState({
        busy: false,
        message: total === 0 ? "All common profiles are already there." : `Added ${r.input} input and ${r.output} output profile${r.output === 1 ? "" : "s"}.`,
      });
    } catch (e) {
      setState({ busy: false, error: errorText(e) });
    }
  };
  return (
    <section className="card gap-2 p-3">
      <div className="flex items-center gap-2 px-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <CardTitle>Common profiles</CardTitle>
          <small className="text-muted">Documents, receipts, photos; PDF, JPEG, PNG and TIFF downloads. Only missing ones are added.</small>
        </div>
        <button className="btn btn-sm" onClick={add} disabled={state.busy}>
          {state.busy ? "Adding…" : "Add"}
        </button>
      </div>
      {state.message && <p className="hint px-1">{state.message}</p>}
      {state.error && <ErrorMessage>{state.error}</ErrorMessage>}
    </section>
  );
}
