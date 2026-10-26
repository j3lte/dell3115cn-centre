/** Desktop right panel before anything was scanned. */
export function EmptyStage({ source }: { source?: "flatbed" | "adf" }) {
  return (
    <section className="card items-center justify-center gap-4 border-dashed text-center lg:sticky lg:top-6 lg:h-[calc(100dvh-3rem)]">
      <svg viewBox="0 0 64 64" aria-hidden="true" className="size-20 fill-none stroke-muted [stroke-width:2]">
        <rect x="16" y="6" width="32" height="40" rx="2" />
        <path d="M22 16h20M22 23h20M22 30h14" />
        <rect x="6" y="38" width="52" height="20" rx="4" className="fill-surface" />
        <path d="M14 48h36" />
      </svg>
      <div className="flex max-w-sm flex-col gap-1">
        <strong>Scanned pages appear here</strong>
        <p className="hint">
          {source === "flatbed"
            ? "Put the document face down on the glass. Use Preview to scan only part of it."
            : "Put the pages in the feeder, face up, top edge first, then press Scan."}
        </p>
      </div>
    </section>
  );
}
