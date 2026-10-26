import { ROUTES } from "../helpers/routes";
import type { Route } from "../types/ui";
import { useHashParts } from "./useHashParts";

export function useRoute(): Route {
  const r = useHashParts()[0] as Route;
  return ROUTES.includes(r) ? r : "scan";
}
