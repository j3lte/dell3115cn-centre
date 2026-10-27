import type { ReactNode } from "react";
import { cx } from "../../helpers/format";
import { ROUTE_LABELS } from "../../helpers/routes";
import type { Route } from "../../types/ui";
import { AnalyseIcon } from "../icons/AnalyseIcon";
import { HistoryIcon } from "../icons/HistoryIcon";
import { PrinterIcon } from "../icons/PrinterIcon";
import { ProfilesIcon } from "../icons/ProfilesIcon";
import { ScanIcon } from "../icons/ScanIcon";
import { SettingsIcon } from "../icons/SettingsIcon";

const ICONS: Record<Route, ReactNode> = {
  scan: <ScanIcon />,
  history: <HistoryIcon />,
  analyse: <AnalyseIcon />,
  printer: <PrinterIcon />,
  profiles: <ProfilesIcon />,
  settings: <SettingsIcon />,
};

/**
 * One navigation link. `tab`: phone bottom bar. `side`: tablet icon rail, a full row on desktop. `dot` marks the
 * Printer tab when the printer reports an error or needs attention.
 */
export function NavItem({ route, current, kind, dot }: { route: Route; current: boolean; kind: "tab" | "side"; dot: "error" | "warning" | null }) {
  return (
    <a
      href={`#/${route}`}
      aria-current={current ? "page" : undefined}
      className={cx(
        "flex items-center font-semibold no-underline",
        kind === "tab" && "flex-col justify-center gap-0.5 text-xs",
        kind === "side" && "min-h-14 flex-col justify-center gap-1 rounded-xl text-[11px] lg:min-h-tap lg:flex-row lg:justify-start lg:gap-3 lg:px-3 lg:text-base",
        current ? "text-accent" : "text-muted hover:text-fg",
        kind === "side" && current && "bg-accent-soft",
      )}
    >
      <span className="relative">
        {ICONS[route]}
        {route === "printer" && dot && (
          <span className={cx("absolute -top-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-surface", dot === "error" ? "bg-danger" : "bg-warn")} aria-label={dot === "error" ? "Printer error" : "Printer needs attention"} />
        )}
      </span>
      <span>{ROUTE_LABELS[route]}</span>
    </a>
  );
}
