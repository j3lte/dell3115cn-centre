import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asObject, candidateName, DeliveryError, oneAtATime, str, ValidationError, type Destination } from "./types";

export type SmbConfig = { server: string; share: string; path: string; username: string; password: string; domain?: string };

export type CommandRunner = (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export const spawnRunner: CommandRunner = async (argv) => {
  if (!Bun.which(argv[0]!)) return { code: 127, stdout: "", stderr: `${argv[0]} is not installed` };
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 120000 });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
};

// smbclient splits -c on ';' (even inside quotes) and quotes with '"', so those can't appear in paths or names.
const UNSAFE = /["';\n\r\\]/;
/** Replaced in remote file names: the -c specials above plus '%', '[', ']', '/' and control characters. */
const UNSAFE_NAME = /["';\\/%[\]\u0000-\u001f\u007f]/g;

function smbError(out: { code: number; stdout: string; stderr: string }): DeliveryError {
  const text = `${out.stderr}\n${out.stdout}`;
  const status = text.match(/NT_STATUS_[A-Z_]+/)?.[0];
  if (status) return new DeliveryError(`SMB: ${status}`);
  const last = text.trim().split("\n").filter(Boolean).at(-1) ?? `smbclient exited with ${out.code}`;
  return new DeliveryError(`SMB: ${last}`);
}

export function createSmbDestination(run: CommandRunner = spawnRunner): Destination<SmbConfig> {
  /** Runs one smbclient command string with a temporary 0600 credentials file. */
  async function smb(c: SmbConfig, command: string) {
    const dir = mkdtempSync(join(tmpdir(), "smb-"));
    const auth = join(dir, "auth");
    try {
      writeFileSync(auth, `username = ${c.username}\npassword = ${c.password}\n${c.domain ? `domain = ${c.domain}\n` : ""}`, { mode: 0o600 });
      return await run(["smbclient", `//${c.server}/${c.share}`, "-A", auth, "-t", "30", "-c", command]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const cd = (c: SmbConfig) => (c.path ? `cd "${c.path}"; ` : "");
  // put/ls use the full remote path rather than relying on cd: if cd failed and smbclient carried on,
  // the file would land in the share root.
  const remotePath = (c: SmbConfig, name: string) => (c.path ? `${c.path}/${name}` : name);

  return {
    type: "smb",
    parse(config) {
      const o = asObject(config);
      const c: SmbConfig = {
        server: str(o, "server", "Server"),
        share: str(o, "share", "Share").replace(/^\/+|\/+$/g, ""),
        path: str(o, "path", "Path", false).replace(/^\/+|\/+$/g, ""),
        username: str(o, "username", "User name", false),
        password: typeof o.password === "string" ? o.password : "",
      };
      const domain = str(o, "domain", "Domain", false);
      if (domain) c.domain = domain;
      if (!/^[A-Za-z0-9._-]+$/.test(c.server)) throw new ValidationError("Server must be a host name or IP address");
      for (const [label, v] of [
        ["Share", c.share],
        ["Path", c.path],
        ["User name", c.username],
        ["Domain", c.domain ?? ""],
      ] as const)
        if (UNSAFE.test(v) || (label === "Share" && v.includes("/"))) throw new ValidationError(`${label} contains characters that are not allowed`);
      if (/[\n\r]/.test(c.password)) throw new ValidationError("Password cannot contain line breaks");
      return c;
    },
    async test(c) {
      const out = await smb(c, `${cd(c)}ls`);
      if (out.code !== 0 || /NT_STATUS_/.test(out.stdout + out.stderr)) throw smbError(out);
    },
    async send(files, c) {
      return oneAtATime(`smb://${c.server}/${c.share}/${c.path}`, async () => {
        const written: string[] = [];
        // The local path holds the raw file name, so each file is uploaded from a copy with a fixed, safe name.
        const dir = mkdtempSync(join(tmpdir(), "smb-up-"));
        try {
          for (const [i, f] of files.entries()) {
            const safe = f.name.replace(UNSAFE_NAME, "_");
            let remote = safe;
            for (let n = 1; ; n++) {
              remote = candidateName(safe, n);
              const ls = await smb(c, `ls "${remotePath(c, remote)}"`);
              const text = ls.stdout + ls.stderr;
              if (/NT_STATUS_NO_SUCH_FILE|NT_STATUS_OBJECT_NAME_NOT_FOUND/.test(text)) break;
              if (ls.code !== 0 || /NT_STATUS_/.test(text)) throw smbError(ls);
              if (n > 999) throw new DeliveryError(`SMB: too many files named like ${safe}`);
            }
            const local = join(dir, `upload-${i + 1}`);
            copyFileSync(f.path, local);
            const put = await smb(c, `put "${local}" "${remotePath(c, remote)}"`);
            if (put.code !== 0 || /NT_STATUS_/.test(put.stdout + put.stderr)) throw smbError(put);
            written.push(remote);
          }
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
        return { ref: written.join(", ") };
      });
    },
  };
}

export const smb = createSmbDestination();
