import { useState } from "react";
import { errorText } from "../lib/errors";
import { ErrorMessage } from "../components/form/ErrorMessage";
import { CleanupSetting } from "../components/settings/CleanupSetting";
import { McpSettings } from "../components/settings/McpSettings";
import { PanelButtonSettings } from "../components/settings/PanelButtonSettings";
import { PrinterWakeSetting } from "../components/settings/PrinterWakeSetting";
import { ThemeSetting } from "../components/settings/ThemeSetting";
import { WhiteCalibrationCard } from "../components/settings/WhiteCalibrationCard";
import { SecretBanner } from "../components/status/SecretBanner";
import { useSaveSettings } from "../hooks/useSaveSettings";
import { useSettings } from "../hooks/useSettings";
import type { Profiles, SaveSetting } from "../types/ui";

export function SettingsPage({ profiles }: { profiles: Profiles }) {
  const { data: settings, error: loadFailure } = useSettings();
  const loadError = loadFailure ? errorText(loadFailure) : undefined;
  const saveSettings = useSaveSettings();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<string>();

  const save: SaveSetting = async (patch, what) => {
    setError(undefined);
    setSaved(undefined);
    try {
      await saveSettings.mutateAsync(patch);
      setSaved(what);
      setTimeout(() => setSaved((s) => (s === what ? undefined : s)), 2500);
    } catch (e) {
      setError(errorText(e));
    }
  };

  if (!settings) return loadError ? <p className="msg msg-error">{loadError}</p> : <p className="hint">Loading…</p>;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="m-0 px-1 text-2xl font-bold">Settings</h1>
      <SecretBanner settings={settings} />
      {error && <ErrorMessage>{error}</ErrorMessage>}
      {saved && (
        <p className="msg msg-ok" role="status">
          ✓ {saved} saved
        </p>
      )}
      <ThemeSetting />
      <WhiteCalibrationCard settings={settings} />
      <CleanupSetting settings={settings} save={save} />
      <PanelButtonSettings settings={settings} profiles={profiles} save={save} />
      <PrinterWakeSetting settings={settings} save={save} />
      <McpSettings settings={settings} save={save} />
    </div>
  );
}
