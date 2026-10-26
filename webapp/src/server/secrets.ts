import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";

export class SecretError extends Error {
  constructor(message = "Cannot decrypt stored credentials; re-enter credentials") {
    super(message);
    this.name = "SecretError";
  }
}

const PREFIX = "enc:v1:";
const IV_LEN = 12;
const TAG_LEN = 16;

/** AES-256-GCM with a key derived from the app secret (SHA-256). Output: "enc:v1:" + base64(iv | ciphertext | tag). */
export class SecretBox {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = createHash("sha256").update(secret, "utf8").digest();
  }

  seal(plain: string): string {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return PREFIX + Buffer.concat([iv, ct, cipher.getAuthTag()]).toString("base64");
  }

  open(sealed: string): string {
    if (!sealed.startsWith(PREFIX)) throw new SecretError("Stored credential is not encrypted");
    const raw = Buffer.from(sealed.slice(PREFIX.length), "base64");
    if (raw.length < IV_LEN + TAG_LEN) throw new SecretError();
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, IV_LEN));
      decipher.setAuthTag(raw.subarray(raw.length - TAG_LEN));
      return Buffer.concat([decipher.update(raw.subarray(IV_LEN, raw.length - TAG_LEN)), decipher.final()]).toString("utf8");
    } catch {
      throw new SecretError();
    }
  }
}

/**
 * APP_SECRET wins. Without it, a generated secret is kept in <dataDir>/app-secret (0600) so credentials stay
 * readable across restarts; `generated: true` tells the caller to show it to the user.
 */
export function resolveAppSecret(config: Config, dataDir: string): { secret: string; generated: boolean } {
  if (config.appSecret) return { secret: config.appSecret, generated: false };
  const file = join(dataDir, "app-secret");
  if (existsSync(file)) {
    const saved = readFileSync(file, "utf8").trim();
    if (saved) return { secret: saved, generated: true };
  }
  mkdirSync(dataDir, { recursive: true });
  const secret = randomBytes(32).toString("base64url");
  writeFileSync(file, secret + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return { secret, generated: true };
}
