import type { Route } from "../types/ui";

/** The app's pages, in navigation order; the first is the default. */
export const ROUTES: Route[] = ["scan", "history", "analyse", "printer", "profiles", "settings"];

export const ROUTE_LABELS: Record<Route, string> = { scan: "Scan", history: "History", analyse: "Analyse", printer: "Printer", profiles: "Profiles", settings: "Settings" };

/** The pages to offer: Analyse only when this deployment has the analyse service. */
export const visibleRoutes = (features: { analyse: boolean }): Route[] => ROUTES.filter((r) => r !== "analyse" || features.analyse);
