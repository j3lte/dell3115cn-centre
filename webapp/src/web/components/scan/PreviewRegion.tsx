import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { errorText } from "../../lib/errors";
import type { AreaMm } from "../../types/api";
import { cx } from "../../helpers/format";
import { GLASS_MM, regionToMm, type Rect } from "../../helpers/region";
import { usePreview } from "../../hooks/usePreview";
import { ErrorMessage } from "../form/ErrorMessage";

type Handle = "move" | "nw" | "ne" | "sw" | "se" | "new";

/**
 * Flatbed preview: runs a quick low-dpi scan of the whole glass, lets the user drag a rectangle (touch-friendly corner
 * handles), and starts a region scan. Region scans always land in the review tray.
 */
export function PreviewRegion({
  disabledReason,
  onScanArea,
  onClose,
}: {
  disabledReason: string | null;
  onScanArea: (area: AreaMm) => Promise<void>;
  onClose: () => void;
}) {
  const [img, setImg] = useState<{ url: string; width: number; height: number }>();
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();
  /** Selection in preview-image pixels. */
  const [rect, setRect] = useState<Rect>();
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ handle: Handle; start: { x: number; y: number }; rect: Rect } | null>(null);
  const preview = usePreview();

  useEffect(() => () => img && URL.revokeObjectURL(img.url), [img]);

  const runPreview = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const blob = await preview.mutateAsync();
      const url = URL.createObjectURL(blob);
      const el = new Image();
      el.src = url;
      await el.decode();
      setImg({ url, width: el.naturalWidth, height: el.naturalHeight });
      setRect(undefined);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  };

  /** Pointer position in preview-image pixels. */
  const toImage = (e: ReactPointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    const s = img!.width / r.width;
    return { x: Math.min(Math.max(e.clientX - r.left, 0), r.width) * s, y: Math.min(Math.max(e.clientY - r.top, 0), r.height) * s };
  };

  const onDown = (e: ReactPointerEvent, handle: Handle) => {
    if (!img) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const p = toImage(e);
    const start = handle === "new" ? { x: p.x, y: p.y, w: 0, h: 0 } : rect!;
    drag.current = { handle, start: p, rect: start };
    if (handle === "new") setRect(start);
  };

  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || !img) return;
    const p = toImage(e);
    const dx = p.x - d.start.x;
    const dy = p.y - d.start.y;
    const r = d.rect;
    let next: Rect;
    switch (d.handle) {
      case "new":
        next = { x: r.x, y: r.y, w: dx, h: dy };
        break;
      case "move":
        next = {
          x: Math.min(Math.max(r.x + dx, 0), img.width - r.w),
          y: Math.min(Math.max(r.y + dy, 0), img.height - r.h),
          w: r.w,
          h: r.h,
        };
        break;
      case "nw":
        next = { x: r.x + dx, y: r.y + dy, w: r.w - dx, h: r.h - dy };
        break;
      case "ne":
        next = { x: r.x, y: r.y + dy, w: r.w + dx, h: r.h - dy };
        break;
      case "sw":
        next = { x: r.x + dx, y: r.y, w: r.w - dx, h: r.h + dy };
        break;
      default:
        next = { x: r.x, y: r.y, w: r.w + dx, h: r.h + dy };
    }
    setRect(next);
  };

  const onUp = () => {
    if (!drag.current || !rect || !img) return;
    drag.current = null;
    // Normalise (dragged up/left) and keep the minimum size, so handles stay where the user sees them.
    const [x, y, w, h] = regionToMm(rect, img, GLASS_MM);
    const s = img.width / GLASS_MM.w;
    setRect({ x: x * s, y: y * s, w: w * s, h: h * s });
  };

  const area = img && rect ? regionToMm(rect, img, GLASS_MM) : null;
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;

  const scan = async () => {
    if (!area) return;
    setStarting(true);
    setError(undefined);
    try {
      await onScanArea(area);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <section className="card min-h-0 lg:sticky lg:top-6 lg:max-h-[calc(100dvh-3rem)]">
      <div className="flex min-h-tap items-center gap-2">
        <h2 className="m-0 flex-1 text-lg font-bold">Preview</h2>
        <button className="icon-btn" aria-label="Close preview" onClick={onClose}>
          ×
        </button>
      </div>
      {!img && (
        <p className="hint">A quick low-resolution scan of the whole glass. Then drag a rectangle around what you want to scan. Area scans always open the review tray.</p>
      )}
      {img && (
        <div className="flex min-h-0 justify-center overflow-hidden rounded-xl bg-surface-2 p-3">
          <div
            ref={box}
            className="relative inline-block max-w-full touch-none select-none"
            onPointerDown={(e) => onDown(e, "new")}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            data-testid="preview-box"
          >
            <img src={img.url} alt="Preview of the scanner glass" draggable={false} className="paper block max-h-[max(320px,calc(100dvh-300px))] w-auto max-w-full" />
            {rect && (
              <div
                className="absolute cursor-move border-2 border-accent bg-accent/15 shadow-[0_0_0_9999px_rgb(0_0_0/0.35)]"
                style={{
                  left: pct(Math.min(rect.x, rect.x + rect.w), img.width),
                  top: pct(Math.min(rect.y, rect.y + rect.h), img.height),
                  width: pct(Math.abs(rect.w), img.width),
                  height: pct(Math.abs(rect.h), img.height),
                }}
                onPointerDown={(e) => onDown(e, "move")}
              >
                {(["nw", "ne", "sw", "se"] as const).map((h) => (
                  <span
                    key={h}
                    aria-hidden="true"
                    onPointerDown={(e) => onDown(e, h)}
                    className={cx(
                      "absolute grid size-tap place-items-center after:block after:size-4 after:rounded-full after:border-2 after:border-white after:bg-accent",
                      h === "nw" && "-top-[22px] -left-[22px] cursor-nwse-resize",
                      h === "ne" && "-top-[22px] -right-[22px] cursor-nesw-resize",
                      h === "sw" && "-bottom-[22px] -left-[22px] cursor-nesw-resize",
                      h === "se" && "-right-[22px] -bottom-[22px] cursor-nwse-resize",
                    )}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {area && (
        <p className="hint text-center">
          Area {Math.round(area[2])} × {Math.round(area[3])} mm
        </p>
      )}
      {img && !rect && <p className="hint text-center">Drag on the preview to select an area.</p>}
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <div className="flex flex-wrap gap-2.5">
        <button className="btn flex-1" disabled={loading || !!disabledReason} onClick={runPreview}>
          {loading ? "Scanning preview…" : img ? "Preview again" : "Run preview"}
        </button>
        {img && (
          <button className="btn btn-primary flex-1" disabled={!area || starting || !!disabledReason} onClick={scan}>
            {starting ? "Starting…" : "Scan area"}
          </button>
        )}
      </div>
      {disabledReason && <p className="hint text-center">{disabledReason}</p>}
    </section>
  );
}
