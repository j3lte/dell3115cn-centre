import { cx } from "../../helpers/format";
import type { Route } from "../../types/ui";
import { NavItem } from "./NavItem";

/** Phone tab bar along the bottom edge (hidden from tablet width). */
export function BottomNav({ route, routes, dot }: { route: Route; routes: Route[]; dot: "error" | "warning" | null }) {
  return (
    <nav
      aria-label="Main"
      className={cx(
        "fixed inset-x-0 bottom-0 z-20 grid h-[calc(64px+env(safe-area-inset-bottom))] border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden",
        routes.length > 5 ? "grid-cols-6" : "grid-cols-5",
      )}
    >
      {routes.map((r) => (
        <NavItem key={r} route={r} current={r === route} kind="tab" dot={dot} />
      ))}
    </nav>
  );
}
