import { useEffect, useMemo, useState } from "react";
import { FORMAT_LABEL, RETIRED_DEST_MESSAGE, RETIRED_DESTS, type DestType } from "../../helpers/labels";
import { DEST_FIELDS, destOptions, filenameExamples, NEW_OUTPUT, withDestField } from "../../helpers/profiles";
import { useDeleteOutputProfile } from "../../hooks/useDeleteOutputProfile";
import { flashSaved, useSaveProfile } from "../../hooks/useSaveProfile";
import { useSaveOutputProfile } from "../../hooks/useSaveOutputProfile";
import { useTestDestination } from "../../hooks/useTestDestination";
import { errorText } from "../../lib/errors";
import { go } from "../../lib/router";
import type { OutputProfile, OutputProfileDraft } from "../../types/api";
import { ErrorMessage } from "../form/ErrorMessage";
import { Field } from "../form/Field";
import { SelectField } from "../form/SelectField";
import { Slider } from "../ui/Slider";
import { DestinationField } from "./DestinationField";
import { FormShell } from "./FormShell";

const FORMAT_OPTIONS = (Object.keys(FORMAT_LABEL) as OutputProfileDraft["format"][]).map((f) => [f, FORMAT_LABEL[f]] as const);

/** Creates (`profile` null) or edits an output profile; the draft is local until saved. */
export function OutputProfileForm({ profile }: { profile: OutputProfile | null }) {
  const saveProfile = useSaveOutputProfile();
  const deleteProfile = useDeleteOutputProfile();
  const testDestination = useTestDestination();
  const [d, setD] = useState<OutputProfileDraft>(profile ? { ...profile, destination: { ...profile.destination, config: { ...profile.destination.config } } } : NEW_OUTPUT);
  const [test, setTest] = useState<{ state: "idle" | "running" | "ok" | "error"; message?: string }>({ state: "idle" });
  const set = (patch: Partial<OutputProfileDraft>) => setD((x) => ({ ...x, ...patch }));
  const setCfg = (key: string, v: unknown) =>
    setD((x) => ({ ...x, destination: { ...x.destination, config: withDestField(x.destination.type, x.destination.config, key, v) } }));
  // A changed destination forgets the last test's answer; the host key that answer filled in is not a change.
  const { hostKey: _hostKey, ...target } = d.destination.config;
  useEffect(() => setTest({ state: "idle" }), [d.destination.type, JSON.stringify(target)]); // eslint-disable-line react-hooks/exhaustive-deps

  const s = useSaveProfile(
    () => saveProfile.mutateAsync({ ...d, id: profile?.id }),
    (v) => {
      if (!profile) {
        flashSaved();
        go("profiles", "out", v.id);
      }
    },
  );
  const remove = async () => {
    try {
      await deleteProfile.mutateAsync(profile!.id);
      go("profiles");
    } catch (e) {
      s.setError(errorText(e));
    }
  };
  const runTest = async () => {
    setTest({ state: "running" });
    try {
      const r = await testDestination.mutateAsync({ type: d.destination.type, config: d.destination.config, id: profile?.id });
      if (r.hostKey) setCfg("hostKey", r.hostKey); // trusted on first use; saved with the profile
      setTest({ state: "ok", message: "Connection works." });
    } catch (e) {
      setTest({ state: "error", message: errorText(e) });
    }
  };

  const examples = useMemo(() => filenameExamples(d.filenameTemplate, d.format, d.name, new Date()), [d.filenameTemplate, d.format, d.name]);
  const fields = DEST_FIELDS[d.destination.type];
  const retired = RETIRED_DESTS.includes(d.destination.type);
  const usesQuality = d.format === "jpeg" || d.format === "pdf_multi" || d.format === "pdf_single";

  return (
    <FormShell
      title={profile ? `Output profile: ${profile.name}` : "New output profile"}
      saving={s.saving}
      error={s.error}
      ok={s.ok}
      onSave={s.run}
      onDelete={profile ? remove : undefined}
    >
      {profile?.needsCredentials && <p className="msg msg-error">The stored credentials can't be decrypted (APP_SECRET changed). Re-enter them and save.</p>}
      <Field label="Name">
        <input className="control" required value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="Archive → Paperless" />
      </Field>
      <SelectField label="Format" value={d.format} options={FORMAT_OPTIONS} onChange={(v) => set({ format: v as OutputProfileDraft["format"] })} />
      {usesQuality && (
        <Slider
          label={d.format === "jpeg" ? "JPEG quality" : "Image quality inside the PDF"}
          value={d.jpegQuality}
          min={30}
          max={100}
          step={5}
          onChange={(jpegQuality) => set({ jpegQuality })}
        />
      )}
      <div className="field">
        <Field label="File name">
          <input className="control font-mono" required value={d.filenameTemplate} onChange={(e) => set({ filenameTemplate: e.target.value })} spellCheck={false} autoCapitalize="off" />
        </Field>
        <small className="text-muted">
          Placeholders: <code>{"{date}"}</code> <code>{"{time}"}</code> <code>{"{datetime}"}</code> <code>{"{profile}"}</code> <code>{"{input}"}</code> <code>{"{n}"}</code>{" "}
          <code>{"{page}"}</code>
        </small>
        <small className="break-all">
          Example: <strong>{examples.join(", ")}</strong>
          {examples.length > 1 ? ", …" : ""}
        </small>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-line p-3">
        <SelectField label="Destination" value={d.destination.type} options={destOptions(d.destination.type)} onChange={(v) => set({ destination: { type: v as DestType, config: {} } })} />
        {d.destination.type === "download" && <p className="hint">The browser downloads the file(s). Scans from the printer button wait in History.</p>}
        {retired && <ErrorMessage>{RETIRED_DEST_MESSAGE}</ErrorMessage>}
        {fields.map((f) => (
          <DestinationField key={`${d.destination.type}.${f.key}`} spec={f} value={d.destination.config[f.key]} onChange={(v) => setCfg(f.key, v)} />
        ))}
        {d.destination.type !== "download" && !retired && (
          <div className="flex flex-col gap-2">
            <button type="button" className="btn" onClick={runTest} disabled={test.state === "running"}>
              {test.state === "running" ? "Testing…" : "Test"}
            </button>
            {test.state === "ok" && <p className="msg msg-ok">✓ {test.message}</p>}
            {test.state === "error" && <ErrorMessage>{test.message}</ErrorMessage>}
          </div>
        )}
      </div>
    </FormShell>
  );
}
