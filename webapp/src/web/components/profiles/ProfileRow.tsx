import { memo } from "react";
import { cx } from "../../helpers/format";

export type ProfileItem = { id: number; name: string; sub: string; badge?: string };

/** One profile in a list, linking to its form. Memoized: a list re-render skips the rows whose profile is unchanged. */
export const ProfileRow = memo(function ProfileRow({ item, href, active }: { item: ProfileItem; href: string; active: boolean }) {
  return (
    <li>
      <a
        href={href}
        aria-current={active ? "true" : undefined}
        className={cx("flex min-h-tap flex-col justify-center rounded-xl px-3 py-2 text-fg no-underline hover:bg-surface-2", active && "bg-accent-soft hover:bg-accent-soft")}
      >
        <span className="flex items-center gap-2 font-semibold">
          <span className="truncate">{item.name}</span>
          {item.badge && <span className="badge badge-error">{item.badge}</span>}
        </span>
        <small className="truncate text-muted">{item.sub}</small>
      </a>
    </li>
  );
});
