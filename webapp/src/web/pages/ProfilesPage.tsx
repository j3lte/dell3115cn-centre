import { useMemo, type ReactNode } from "react";
import { CommonProfiles } from "../components/profiles/CommonProfiles";
import { InputProfileForm } from "../components/profiles/InputProfileForm";
import { OutputProfileForm } from "../components/profiles/OutputProfileForm";
import { ProfileList } from "../components/profiles/ProfileList";
import { SecretBanner } from "../components/status/SecretBanner";
import { EmptyState } from "../components/ui/EmptyState";
import { MEDIA } from "../helpers/media";
import { inputSummary, outputSummary } from "../helpers/profiles";
import { useHashParts } from "../hooks/useHashParts";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useSettings } from "../hooks/useSettings";
import { go } from "../lib/router";
import type { ProfileKind, Profiles } from "../types/ui";

const newInput = () => go("profiles", "in", "new");
const newOutput = () => go("profiles", "out", "new");

export function ProfilesPage({ profiles }: { profiles: Profiles }) {
  const parts = useHashParts();
  const desktop = useMediaQuery(MEDIA.lg);
  const { data: settings } = useSettings();
  const kind = (parts[1] === "in" || parts[1] === "out" ? parts[1] : null) as ProfileKind | null;
  const id = parts[2] === "new" ? "new" : parts[2] ? Number(parts[2]) : null;
  const selected = kind && id !== null;
  const selectedId = typeof id === "number" ? id : null;

  // Stable rows while the lists are unchanged, so the memoized rows skip re-rendering.
  const inputItems = useMemo(() => profiles.inputs.map((p) => ({ id: p.id, name: p.name, sub: inputSummary(p) })), [profiles.inputs]);
  const outputItems = useMemo(
    () => profiles.outputs.map((p) => ({ id: p.id, name: p.name, sub: outputSummary(p), badge: p.needsCredentials ? "re-enter credentials" : undefined })),
    [profiles.outputs],
  );

  const list = (
    <div className="flex flex-col gap-4">
      <ProfileList kind="in" items={inputItems} selectedId={kind === "in" ? selectedId : null} onNew={newInput} />
      <ProfileList kind="out" items={outputItems} selectedId={kind === "out" ? selectedId : null} onNew={newOutput} />
      <CommonProfiles />
    </div>
  );

  let editor: ReactNode = null;
  if (kind === "in" && id !== null) {
    const p = id === "new" ? null : profiles.inputs.find((x) => x.id === id);
    editor = id === "new" || p ? <InputProfileForm key={String(id)} profile={p ?? null} /> : <p className="hint">Profile not found.</p>;
  } else if (kind === "out" && id !== null) {
    const p = id === "new" ? null : profiles.outputs.find((x) => x.id === id);
    editor = id === "new" || p ? <OutputProfileForm key={String(id)} profile={p ?? null} /> : <p className="hint">Profile not found.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <SecretBanner settings={settings} />
      {desktop ? (
        <div className="grid grid-cols-[minmax(300px,380px)_minmax(0,1fr)] items-start gap-6">
          {list}
          <div className="min-w-0">{editor ?? <EmptyState>Select a profile, or create a new one.</EmptyState>}</div>
        </div>
      ) : selected ? (
        <div className="flex flex-col gap-3">
          <a href="#/profiles" className="btn self-start">
            ← Profiles
          </a>
          {editor}
        </div>
      ) : (
        list
      )}
    </div>
  );
}
