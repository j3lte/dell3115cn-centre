import { cx } from "../../helpers/format";
import { supplyLabel } from "../../helpers/printer";
import type { Supply } from "../../types/api";

/** Bar colour per CUPS marker colour; black follows the theme's text colour, the belt unit and fuser ("none") are muted. */
const BAR: Record<string, string> = { cyan: "bg-[#00a3e0]", magenta: "bg-[#d6007e]", yellow: "bg-[#f2c500]", none: "bg-muted" };

/** One row of the Supplies list: name, level bar, and the level as text; a low supply is highlighted. */
export function SupplyBar({ supply: s }: { supply: Supply }) {
  const { name, value } = supplyLabel(s);
  return (
    <li className="contents">
      <span className={cx(s.low && "font-semibold text-warn")}>{name}</span>
      <span className="h-2.5 overflow-hidden rounded-full bg-line" role="meter" aria-label={s.name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={s.level ?? undefined}>
        <span className={cx("block h-full rounded-full", BAR[s.color] ?? "bg-fg")} style={{ width: `${s.level ?? 0}%` }} />
      </span>
      <span className={cx("text-right tabular-nums", s.low ? "font-semibold text-warn" : "text-muted")}>{value}</span>
    </li>
  );
}
