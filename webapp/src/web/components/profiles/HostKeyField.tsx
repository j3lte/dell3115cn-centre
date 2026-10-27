import { useForgetHostKey } from "../../hooks/useForgetHostKey";
import { useHostKey } from "../../hooks/useHostKey";
import { errorText } from "../../lib/errors";
import { ErrorMessage } from "../form/ErrorMessage";

/** The SSH host key the server trusts for this SFTP host:port (stored on first login), with a way to forget it. */
export function HostKeyField({ host, port }: { host: string; port: number }) {
  const key = useHostKey(host, port);
  const forget = useForgetHostKey();
  const fingerprint = key.data?.fingerprint;
  const status = key.isError
    ? `Couldn't read the stored host key: ${errorText(key.error)}`
    : fingerprint
      ? "Connections are refused if the server shows another key. Forget it only if the server's key really changed."
      : key.isPending
        ? "Loading…"
        : "Not stored yet: the first successful login (Test or delivery) trusts the server's key and stores it.";
  return (
    <div className="field">
      <span className="field-label">Host key</span>
      {fingerprint && <code className="break-all">{fingerprint}</code>}
      <small className="text-muted">{status}</small>
      {(fingerprint || key.isError) && (
        <button type="button" className="btn btn-sm self-start" disabled={forget.isPending} onClick={() => forget.mutate({ host, port })}>
          Forget host key
        </button>
      )}
      {forget.error && <ErrorMessage>{errorText(forget.error)}</ErrorMessage>}
    </div>
  );
}
