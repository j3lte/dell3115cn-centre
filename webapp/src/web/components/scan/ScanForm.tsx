import type { Profiles, ScanChoice } from "../../types/ui";
import { cx } from "../../helpers/format";
import type { ScanStarter } from "../../hooks/useScanStarter";
import { ErrorMessage } from "../form/ErrorMessage";
import { SelectField } from "../form/SelectField";
import { Toggle } from "../ui/Toggle";

/** The Scan page's start card: input and output profile, review toggle, hints, Preview and Scan. */
export function ScanForm({
  profiles,
  choice,
  starter,
  reason,
  noPaper,
  busy,
  previewing,
  onPreviewingChange,
}: {
  profiles: Profiles;
  choice: ScanChoice;
  starter: ScanStarter;
  /** Why Scan is disabled (null = it can start). */
  reason: string | null;
  /** The feeder is selected and the scanner reports no paper in it. */
  noPaper: boolean;
  /** A scan is in progress. */
  busy: boolean;
  previewing: boolean;
  onPreviewingChange: (v: boolean) => void;
}) {
  const { inputs, outputs } = profiles;
  const { input, output } = choice;
  return (
    <section className="card">
      <SelectField
        label="Input profile"
        value={input?.id ?? ""}
        options={inputs.map((p) => [p.id, p.name] as const)}
        onChange={(v) => choice.setInputId(Number(v))}
        disabled={!inputs.length}
      />
      <SelectField
        label="Output profile"
        value={output?.id ?? ""}
        options={outputs.map((p) => [p.id, `${p.name}${p.needsCredentials ? " (re-enter credentials)" : ""}`] as const)}
        onChange={(v) => choice.setOutputId(Number(v))}
        disabled={!outputs.length}
      />
      <Toggle label="Review before sending" checked={choice.review} onChange={choice.setReview} />
      {noPaper && <p className="hint">No paper detected in the feeder.</p>}
      {input?.source === "flatbed" && output?.format === "pdf_multi" && <p className="hint">Flatbed to a multi-page PDF opens the review tray: scan page by page.</p>}
      <div className="flex gap-2.5">
        {input?.source === "flatbed" && (
          <button className={cx("btn btn-big flex-1", previewing && "border-accent text-accent")} disabled={busy} onClick={() => onPreviewingChange(!previewing)} aria-pressed={previewing}>
            Preview
          </button>
        )}
        <button className="btn btn-primary btn-big flex-[2]" disabled={!!reason || starter.starting} onClick={starter.start}>
          {starter.starting ? "Starting…" : "Scan"}
        </button>
      </div>
      {reason && <p className="hint text-center">{reason}</p>}
      {starter.error && <ErrorMessage>{starter.error}</ErrorMessage>}
    </section>
  );
}
