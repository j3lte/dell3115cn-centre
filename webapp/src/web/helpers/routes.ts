import type { Route } from "../types/ui";

/** The app's pages, in navigation order; the first is the default. */
export const ROUTES: Route[] = ["scan", "history", "printer", "profiles", "settings"];

export const ROUTE_LABELS: Record<Route, string> = { scan: "Scan", history: "History", printer: "Printer", profiles: "Profiles", settings: "Settings" };
