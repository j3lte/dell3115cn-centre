import type { DeliveryView } from "../../types/api";
import { downloadFiles } from "../../helpers/download";
import { cx } from "../../helpers/format";

/** Download links for the files of a delivery (`small` buttons in History), with "Download all" for several files when asked. */
export function DownloadList({ files, small = false, downloadAll = false }: { files: DeliveryView["files"]; small?: boolean; downloadAll?: boolean }) {
  if (!files.length) return null;
  return (
    <div className={cx("flex flex-col", small ? "gap-1.5" : "gap-2")}>
      {files.map((f) => (
        <a key={f.url} className={cx("btn", small && "btn-sm", "justify-start")} href={f.url} download={f.name}>
          ↓ {f.name}
        </a>
      ))}
      {downloadAll && files.length > 1 && (
        <button className="btn" onClick={() => downloadFiles(files)}>
          Download all
        </button>
      )}
    </div>
  );
}
