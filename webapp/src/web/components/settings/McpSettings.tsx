import { useEffect, useState } from "react";
import { errorText } from "../../lib/errors";
import type { Settings } from "../../types/api";
import type { SaveSetting } from "../../types/ui";
import { mcpClientSnippets } from "../../helpers/settings";
import { useRegenerateMcpKey } from "../../hooks/useRegenerateMcpKey";
import { ErrorMessage } from "../form/ErrorMessage";
import { Field } from "../form/Field";
import { CardTitle } from "../ui/CardTitle";
import { Confirm } from "../ui/Confirm";
import { Toggle } from "../ui/Toggle";
import { CopyLine } from "./CopyLine";

/** Settings card for AI assistants: on/off, the key (copy, regenerate), shelf life of their scans, client setup. */
export function McpSettings({ settings, save }: { settings: Settings; save: SaveSetting }) {
  const regenerateKey = useRegenerateMcpKey();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string>();
  const [minutes, setMinutes] = useState(String(settings.mcpShelfLifeMinutes));
  useEffect(() => setMinutes(String(settings.mcpShelfLifeMinutes)), [settings.mcpShelfLifeMinutes]);
  const url = `${location.origin}/mcp/`;
  const key = settings.mcpKey ?? "";
  const snippets = mcpClientSnippets(url, key);

  const regenerate = async () => {
    setError(undefined);
    try {
      await regenerateKey.mutateAsync();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <section className="card">
      <CardTitle>AI assistants (MCP)</CardTitle>
      <p className="hint">
        Lets an assistant such as Claude check the scanner, scan with its own settings, look at pages and download the results. Its scans are temporary
        unless it stores them; nothing is sent to a destination unless you ask.
      </p>
      <Toggle
        label="Allow AI assistants"
        hint={settings.mcpEnabled ? "The MCP endpoint is on." : "Off: the MCP endpoint does not answer and download links stop working."}
        checked={settings.mcpEnabled}
        onChange={(on) => save({ mcpEnabled: on }, "MCP")}
      />
      {settings.mcpEnabled && (
        <>
          <CopyLine label="Endpoint" value={url} />
          <CopyLine label="Key" value={key} />
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-sm" onClick={() => setConfirm(true)}>
              Regenerate key
            </button>
            <small className="flex-1 text-muted">Anyone who can open this web app can see this key.</small>
          </div>
          <CopyLine label="Claude Code" value={snippets.claudeCode} />
          <CopyLine label="Other clients: header" value={snippets.header} />
          <form
            className="flex flex-wrap items-end gap-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              void save({ mcpShelfLifeMinutes: Math.round(Number(minutes)) }, "Shelf life");
            }}
          >
            <Field label="Keep temporary assistant scans for (minutes)" className="flex-1 basis-40">
              <input className="control" type="number" min={5} max={1440} inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
            </Field>
            <button className="btn" type="submit" disabled={String(settings.mcpShelfLifeMinutes) === minutes}>
              Save
            </button>
          </form>
        </>
      )}
      {error && <ErrorMessage>{error}</ErrorMessage>}
      <Confirm
        open={confirm}
        onOpenChange={setConfirm}
        title="Regenerate the MCP key?"
        body="Assistants using the current key stop working until you update them."
        confirmLabel="Regenerate"
        onConfirm={() => void regenerate()}
      />
    </section>
  );
}
