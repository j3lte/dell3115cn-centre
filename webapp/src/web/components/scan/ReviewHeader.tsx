import type { ScanView } from "../../types/api";
import { plural } from "../../helpers/format";
import { Spinner } from "../ui/Spinner";
import { ProblemLine } from "./ProblemLine";

/** Review tray title (page count or scanning progress), problem and error. */
export function ReviewHeader({ scan, busy }: { scan: ScanView; busy: boolean }) {
  const scanning = scan.status === "scanning";
  const flatbed = scan.inputProfile.source === "flatbed";
  const n = scan.pages.length;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-h-tap items-center gap-2.5">
        {(scanning || busy) && <Spinner />}
        <h2 className="m-0 flex-1 text-lg font-bold">{scanning ? `Scanning page ${n + 1}…` : `Review · ${plural(n, "page")}`}</h2>
      </div>
      <ProblemLine problem={scan.problem} />
      {scan.error && <p className="msg msg-error">{scan.error}</p>}
      {!scanning && n === 0 && <p className="hint">No pages yet. Use “{flatbed ? "Scan next page" : "Scan more"}”.</p>}
    </div>
  );
}
