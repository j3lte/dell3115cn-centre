import { memo } from "react";
import { cx } from "../../helpers/format";

/**
 * One numbered thumbnail of the strip; a button when the strip picks pages. Memoized with plain props: the strip
 * re-renders per page, and each socket message brings new page objects with the same values.
 */
export const PageThumb = memo(function PageThumb({ n, thumbUrl, selected, onSelect }: { n: number; thumbUrl: string; selected: boolean; onSelect?: (n: number) => void }) {
  const img = <img src={thumbUrl} alt={`Page ${n}`} loading="lazy" className="paper block h-21 w-auto" />;
  return (
    <li className="relative flex-none">
      {onSelect ? (
        <button
          onClick={() => onSelect(n)}
          aria-pressed={selected}
          className={cx("block cursor-pointer rounded-lg p-0.5", selected ? "ring-3 ring-accent" : "ring-0")}
        >
          {img}
        </button>
      ) : (
        img
      )}
      <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded-md bg-black/60 px-1.5 text-xs text-white">{n}</span>
    </li>
  );
});
