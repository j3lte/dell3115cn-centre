import { useEffect } from "react";
import { useHashParts } from "../hooks/useHashParts";
import { replace } from "../lib/router";
import { DedaPage } from "./DedaPage";

/** Analyse section: a sub-nav and the selected tool. `#/analyse` (or an unknown tool) opens the first one. */
export function AnalysePage() {
  const sub = useHashParts()[1];
  useEffect(() => {
    if (sub !== "deda") replace("analyse", "deda");
  }, [sub]);

  return (
    <div className="flex flex-col gap-4">
      <nav aria-label="Analyse" className="flex gap-2">
        <a href="#/analyse/deda" aria-current={sub === "deda" ? "page" : undefined} className="rounded-lg px-3 py-2 font-semibold no-underline aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent text-muted">
          Tracking dots
        </a>
      </nav>
      {sub === "deda" && <DedaPage />}
    </div>
  );
}
