import { download } from "./download";
import { folder } from "./folder";
import { ftp } from "./ftp";
import { papra } from "./papra";
import { paperless } from "./paperless";
import { createSftpDestination, type HostKeyStore, type SftpClientLike } from "./sftp";
import { smb } from "./smb";
import type { Destination, DestinationType } from "./types";
import { ValidationError } from "./types";
import { webhook } from "./webhook";

export * from "./types";

export type Destinations = (type: DestinationType) => Destination<any>;

/** The destination registry. SFTP keeps the host keys it trusts on first use in `hostKeys`. */
export function createDestinations(deps: { hostKeys: HostKeyStore; sftpClient?: () => SftpClientLike }): Destinations {
  const sftp = createSftpDestination(deps.hostKeys, deps.sftpClient);
  const registry: Record<DestinationType, Destination<any>> = { download, folder, sftp, ftp, paperless, papra, webhook, smb };
  return (type) => {
    const d = registry[type];
    if (!d) throw new ValidationError(`Unknown destination: ${type}`);
    return d;
  };
}

/** Destinations no longer offered, with the message their profiles show. */
export const RETIRED_DESTINATIONS: Partial<Record<DestinationType, string>> = Object.fromEntries(
  [smb].map((d) => [d.type, d.retired!]),
);
