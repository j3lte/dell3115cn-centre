import { ROUTES } from "../../helpers/routes";
import type { Route } from "../../types/ui";
import { NavItem } from "./NavItem";

/** Phone tab bar along the bottom edge (hidden from tablet width). */
export function BottomNav({ route, dot }: { route: Route; dot: "error" | "warning" | null }) {
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-20 grid h-[calc(64px+env(safe-area-inset-bottom))] grid-cols-5 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {ROUTES.map((r) => (
        <NavItem key={r} route={r} current={r === route} kind="tab" dot={dot} />
      ))}
    </nav>
  );
}
