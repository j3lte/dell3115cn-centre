import type { Route } from "../types/ui";
import { useHashParts } from "./useHashParts";

/** The current page; one that isn't offered (`visible`) falls back to the first. */
export function useRoute(visible: Route[]): Route {
  const r = useHashParts()[0] as Route;
  return visible.includes(r) ? r : "scan";
}
