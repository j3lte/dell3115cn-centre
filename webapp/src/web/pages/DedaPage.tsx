import { DedaActions } from "../components/analyse/DedaActions";
import { DedaList } from "../components/analyse/DedaList";
import { ErrorMessage } from "../components/form/ErrorMessage";
import { Spinner } from "../components/ui/Spinner";
import { useDedaAnalyses } from "../hooks/useDedaAnalyses";
import { errorText } from "../lib/errors";

/** Tracking dots (DEDA): start an analysis, and the analyses so far with their results. */
export function DedaPage() {
  const { data, error } = useDedaAnalyses();
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-bold">Tracking dots (DEDA)</h1>
      <DedaActions />
      {error && <ErrorMessage>{errorText(error)}</ErrorMessage>}
      {data ? <DedaList analyses={data} /> : !error && <Spinner />}
    </div>
  );
}
