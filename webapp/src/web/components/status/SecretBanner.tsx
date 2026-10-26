import { useCopy } from "../../hooks/useCopy";
import type { Settings } from "../../types/api";

/** Warning while destination credentials are encrypted with a generated secret (APP_SECRET not set). */
export function SecretBanner({ settings }: { settings?: Settings }) {
  const line = `APP_SECRET=${settings?.generatedSecret}`;
  const [copied, copy] = useCopy(line);
  if (!settings?.secretGenerated || !settings.generatedSecret) return null;
  return (
    <section role="alert" className="flex flex-col gap-2 rounded-2xl border border-warn bg-warn-soft p-4 text-fg">
      <strong className="text-warn">APP_SECRET is not set</strong>
      <p className="m-0 text-sm">
        Saved passwords and tokens are encrypted with a generated secret. Set it in your compose file to keep credentials readable:
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 rounded-lg bg-surface px-3 py-2 font-mono text-sm break-all select-all">{line}</code>
        <button className="btn btn-sm" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </section>
  );
}
