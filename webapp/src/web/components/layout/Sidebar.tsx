import type { LiveState, Route } from "../../types/ui";
import { ConnectionBar } from "../status/ConnectionBar";
import { PrinterAlert } from "../status/PrinterAlert";
import { Brand } from "./Brand";
import { NavItem } from "./NavItem";

/** Tablet icon rail and desktop sidebar: brand, connection status and printer alert (desktop only), navigation. */
export function Sidebar({
  state,
  onConnect,
  route,
  routes,
  dot,
  printerError,
}: {
  state: LiveState;
  onConnect: () => void;
  route: Route;
  routes: Route[];
  dot: "error" | "warning" | null;
  printerError: string | null;
}) {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-22 flex-col gap-4 border-r border-line bg-surface px-2 py-4 md:flex lg:w-64 lg:px-4">
      <Brand />
      <div className="hidden flex-col gap-2 lg:flex">
        <ConnectionBar state={state} onConnect={onConnect} variant="panel" />
        {printerError && <PrinterAlert text={printerError} variant="panel" />}
      </div>
      <nav aria-label="Main" className="flex flex-col gap-1">
        {routes.map((r) => (
          <NavItem key={r} route={r} current={r === route} kind="side" dot={dot} />
        ))}
      </nav>
    </aside>
  );
}
