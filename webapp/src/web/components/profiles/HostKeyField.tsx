/**
 * SFTP's trusted host key: stored by the server on the first Test or delivery, read-only here. "Forget host key" sets
 * it to null, the explicit value that makes the server forget it on save ("" would keep the stored key).
 */
export function HostKeyField({ label, value, onChange }: { label: string; value: unknown; onChange: (v: unknown) => void }) {
  const key = typeof value === "string" ? value : "";
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      {key ? (
        <div className="flex flex-wrap items-center gap-2">
          <code className="break-all">{key}</code>
          <button type="button" className="btn btn-sm" onClick={() => onChange(null)}>
            Forget host key
          </button>
        </div>
      ) : value === null ? (
        <small className="text-muted">Forgotten when you save: the next Test or delivery trusts the server's key and stores it.</small>
      ) : (
        <small className="text-muted">Not stored yet: the next Test or delivery trusts the server's key and stores it.</small>
      )}
      {key && <small className="text-muted">Connections are refused if the server shows another key. Forget it only if the server's key really changed.</small>}
    </div>
  );
}
