import { useForgetHostKey } from "../../hooks/useForgetHostKey";
import { useHostKey } from "../../hooks/useHostKey";
import { errorText } from "../../lib/errors";
import { ErrorMessage } from "../form/ErrorMessage";

/** The SSH host key the server trusts for this SFTP host:port (stored on first use), with a way to forget it. */
export function HostKeyField({ host, port }: { host: string; port: number }) {
  const key = useHostKey(host, port);
  const forget = useForgetHostKey();
  const fingerprint = key.data?.fingerprint;
  const status = fingerprint
    ? "Connections are refused if the server shows another key. Forget it only if the server's key really changed."
    : key.isPending && host
      ? "Loading…"
      : "Not stored yet: the next Test or delivery trusts the server's key and stores it.";
  return (
    <div className="field">
      <span className="field-label">Host key</span>
      {fingerprint && (
        <div className="flex flex-wrap items-center gap-2">
          <code className="break-all">{fingerprint}</code>
          <button type="button" className="btn btn-sm" disabled={forget.isPending} onClick={() => forget.mutate({ host, port })}>
            Forget host key
          </button>
        </div>
      )}
      <small className="text-muted">{status}</small>
      {forget.error && <ErrorMessage>{errorText(forget.error)}</ErrorMessage>}
    </div>
  );
}
