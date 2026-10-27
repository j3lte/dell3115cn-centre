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

/** Looks a destination up by type; `retired` maps the types no longer offered to the message their profiles show. */
export type Destinations = ((type: DestinationType) => Destination<any>) & { retired: Partial<Record<DestinationType, string>> };

/** The destination registry. SFTP keeps the host keys it trusts on first use in `hostKeys`. */
export function createDestinations(deps: { hostKeys: HostKeyStore; sftpClient?: () => SftpClientLike }): Destinations {
  const sftp = createSftpDestination(deps.hostKeys, deps.sftpClient);
  const registry: Record<DestinationType, Destination<any>> = { download, folder, sftp, ftp, paperless, papra, webhook, smb };
  const retired = Object.fromEntries(Object.values(registry).flatMap((d) => (d.retired ? [[d.type, d.retired]] : [])));
  const get = (type: DestinationType) => {
    const d = registry[type];
    if (!d) throw new ValidationError(`Unknown destination: ${type}`);
    return d;
  };
  return Object.assign(get, { retired });
}
