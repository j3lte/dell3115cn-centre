import type { ProfileKind } from "../../types/ui";
import { CardTitle } from "../ui/CardTitle";
import { ProfileRow, type ProfileItem } from "./ProfileRow";

const TEXT: Record<ProfileKind, { title: string; hint: string }> = {
  in: { title: "Input profiles", hint: "How to scan: source, colour, resolution." },
  out: { title: "Output profiles", hint: "What to make and where it goes." },
};

/** The input or output profiles, the selected one marked; each row links to `#/profiles/<kind>/<id>`. */
export function ProfileList({ kind, items, selectedId, onNew }: { kind: ProfileKind; items: ProfileItem[]; selectedId: number | null; onNew: () => void }) {
  const { title, hint } = TEXT[kind];
  return (
    <section className="card gap-2 p-3">
      <div className="flex items-center gap-2 px-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <CardTitle>{title}</CardTitle>
          <small className="text-muted">{hint}</small>
        </div>
        <button className="btn btn-sm" onClick={onNew}>
          + New
        </button>
      </div>
      {items.length === 0 && <p className="hint px-1">None yet.</p>}
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {items.map((it) => (
          <ProfileRow key={it.id} item={it} href={`#/profiles/${kind}/${it.id}`} active={it.id === selectedId} />
        ))}
      </ul>
    </section>
  );
}
