import { DEDA_CLOSEUPS, dedaImageUrl } from "../../helpers/deda";
import type { DedaView } from "../../types/api";

/**
 * What an analysis found: an overview of the page, close-ups of the dots (as scanned, enhanced, and their yellowness),
 * the decoded fields, or that no dots were found. A failed analysis shows its error.
 */
export function DedaResult({ analysis: a }: { analysis: DedaView }) {
  if (a.status === "failed") return <p className="msg msg-error">{a.error ?? "The analysis failed."}</p>;
  if (a.status !== "done") return null;
  const has = (name: string) => a.images.includes(name);
  const closeups = DEDA_CLOSEUPS.filter(([name]) => has(name));
  return (
    <div className="flex flex-col gap-3">
      {a.found === false && <p className="msg msg-warn">No tracking dots found.</p>}
      {a.found && a.dots !== null && <p className="hint">{a.dots} dots found.</p>}
      {has("overview") && <img src={dedaImageUrl(a.id, "overview")} alt="Overview of the page" loading="lazy" className="paper max-h-96 w-full object-contain" />}
      {closeups.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {closeups.map(([name, caption]) => (
            <figure key={name} className="m-0 flex min-w-0 flex-col gap-1">
              <img src={dedaImageUrl(a.id, name)} alt={`Close-up: ${caption}`} loading="lazy" className="paper aspect-square w-full object-cover [image-rendering:pixelated]" />
              <figcaption className="text-center text-sm text-muted">{caption}</figcaption>
            </figure>
          ))}
        </div>
      )}
      {a.decode && (
        <table className="w-full border-collapse text-sm">
          <tbody>
            {Object.entries(a.decode).map(([k, v]) => (
              <tr key={k} className="border-t border-line">
                <th scope="row" className="py-1.5 pr-3 text-left font-semibold text-muted">
                  {k}
                </th>
                <td className="py-1.5 font-mono [overflow-wrap:anywhere]">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {a.found && !a.decode && a.decodeError && <p className="hint">{a.decodeError}</p>}
    </div>
  );
}
