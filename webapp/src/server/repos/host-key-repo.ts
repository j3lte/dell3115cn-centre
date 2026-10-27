import type { Database } from "bun:sqlite";
import type { HostKeyStore, TrustedHostKey } from "../destinations/sftp";

/** The `host_keys` table: SFTP host keys trusted on first use. SQL only; the trust rules live in `destinations/sftp.ts`. */
export class HostKeyRepo implements HostKeyStore {
  constructor(
    private readonly db: Database,
    private readonly clock: () => number = Date.now,
  ) {}

  get(host: string, port: number): TrustedHostKey | null {
    const r = this.db
      .query<{ fingerprint: string; first_seen: number }, [string, number]>("SELECT fingerprint, first_seen FROM host_keys WHERE host = ? AND port = ?")
      .get(host.toLowerCase(), port);
    return r ? { fingerprint: r.fingerprint, firstSeen: r.first_seen } : null;
  }

  /** Keeps a key that is already there; returns the key now stored. */
  set(host: string, port: number, fingerprint: string): string {
    this.db
      .query("INSERT INTO host_keys (host, port, fingerprint, first_seen) VALUES (?, ?, ?, ?) ON CONFLICT (host, port) DO NOTHING")
      .run(host.toLowerCase(), port, fingerprint, this.clock());
    return this.get(host, port)!.fingerprint;
  }

  forget(host: string, port: number): void {
    this.db.query("DELETE FROM host_keys WHERE host = ? AND port = ?").run(host.toLowerCase(), port);
  }
}
