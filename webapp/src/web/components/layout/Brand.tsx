import { BRAND_NAME } from "../../helpers/labels";
import { DellMfpIcon } from "../icons/DellMfpIcon";

/** Printer drawing and name at the top of the sidebar; the name shows from desktop width. */
export function Brand() {
  return (
    <div className="flex items-center gap-2 px-1 lg:px-2">
      <span className="grid size-10 place-items-center rounded-xl bg-accent text-accent-fg">
        <DellMfpIcon />
      </span>
      <strong className="hidden text-lg lg:inline">{BRAND_NAME}</strong>
    </div>
  );
}
