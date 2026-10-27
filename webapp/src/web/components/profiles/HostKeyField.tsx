/** SFTP's trusted host key: stored by the first Test or delivery, read-only here; forgetting it trusts the next one. */
export function HostKeyField({ label, value, onChange }: { label: string; value: unknown; onChange: (v: unknown) => void }) {
  const key = typeof value === "string" ? value : "";
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      {key ? (
        <div className="flex flex-wrap items-center gap-2">
          <code className="break-all">{key}</code>
          <button type="button" className="btn btn-sm" onClick={() => onChange("")}>
            Forget host key
          </button>
        </div>
      ) : (
        <small className="text-muted">Not stored yet: the next Test or delivery trusts the server's key and stores it.</small>
      )}
      {key && <small className="text-muted">Connections are refused if the server shows another key. Forget it only if the server's key really changed.</small>}
    </div>
  );
}
