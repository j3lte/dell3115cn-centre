import { download } from "./download";
import { folder } from "./folder";
import { ftp } from "./ftp";
import { papra } from "./papra";
import { paperless } from "./paperless";
import { smb } from "./smb";
import type { Destination, DestinationType } from "./types";
import { ValidationError } from "./types";
import { webhook } from "./webhook";

export * from "./types";

const REGISTRY: Record<DestinationType, Destination<any>> = { download, folder, smb, ftp, paperless, papra, webhook };

export function getDestination(type: DestinationType): Destination<any> {
  const d = REGISTRY[type];
  if (!d) throw new ValidationError(`Unknown destination: ${type}`);
  return d;
}
