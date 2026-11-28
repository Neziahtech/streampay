import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Secrets that never leave the process in plaintext are stored as a
 * self-describing envelope in the `secret` column. A prefix makes the on-disk
 * form unmistakable, so a row written by an older, plaintext build stays
 * readable while nothing new is ever written unencrypted.
 */
export const ENCRYPTED_SECRET_PREFIX = "spwsec:v1:";

/** Length of a generated signing secret, in bytes of entropy. */
const SECRET_BYTES = 32;

/** The env var holding the 256-bit master key. */
export const SECRET_ENCRYPTION_KEY_ENV = "WEBHOOK_SECRET_ENCRYPTION_KEY";

export class SecretEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretEncryptionError";
  }
}

function normalizeKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  if (trimmed.length === 0) throw new SecretEncryptionError(`${SECRET_ENCRYPTION_KEY_ENV} is empty`);
  // A non-hex key is accepted through the same KDF as the hex form, so a
  // operator-supplied passphrase cannot silently weaken the cipher.
  return createHash("sha256").update(trimmed, "utf8").digest();
}

/**
 * AES-256-GCM envelope for webhook signing secrets.
 *
 * The additional authenticated data binds an envelope to the subscription it
 * belongs to: copying another tenant's ciphertext into this row fails the tag
 * check instead of handing out someone else's secret.
 */
export class SecretCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) {
      throw new SecretEncryptionError("webhook secret encryption key must be 32 bytes");
    }
  }

  /** Returns `null` when unset so callers can fall back to an unencrypted store. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): SecretCipher | null {
    const raw = env[SECRET_ENCRYPTION_KEY_ENV];
    if (raw === undefined || raw.trim() === "") return null;
    return new SecretCipher(normalizeKey(raw));
  }

  static fromPassphrase(passphrase: string): SecretCipher {
    return new SecretCipher(normalizeKey(passphrase));
  }

  /**
   * A fresh secret, returned to the subscriber exactly once.
   * `whsec_` keeps the wire format callers already parse.
   */
  static generateSecret(): string {
    return `whsec_${randomBytes(SECRET_BYTES).toString("hex")}`;
  }

  isManaged(value: string): boolean {
    return value.startsWith(ENCRYPTED_SECRET_PREFIX);
  }

  encrypt(plaintext: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${ENCRYPTED_SECRET_PREFIX}${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
  }

  /**
   * Reads an envelope back. Values without the prefix are legacy plaintext rows
   * and pass through untouched, which is what lets a deployment turn encryption
   * on without rewriting existing subscriptions.
   */
  decrypt(value: string, context: string): string {
    if (!this.isManaged(value)) return value;
    const parts = value.slice(ENCRYPTED_SECRET_PREFIX.length).split(".");
    if (parts.length !== 3) {
      throw new SecretEncryptionError("malformed encrypted webhook secret");
    }
    const [iv, tag, ciphertext] = parts.map((p) => Buffer.from(p, "base64url"));
    if (iv.length !== 12 || tag.length !== 16) {
      throw new SecretEncryptionError("malformed encrypted webhook secret");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAAD(Buffer.from(context, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch (err: unknown) {
      throw new SecretEncryptionError(
        `encrypted webhook secret failed authentication (${err instanceof Error ? err.message : String(err)})`
      );
    }
  }

  /**
   * A stable, non-reversible handle for logs, dashboards and rotation history.
   * Enough to match two records, not enough to sign anything.
   */
  static fingerprint(secret: string): string {
    return `sha256:${createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 16)}`;
  }

  /** True when `candidate` is the secret `fingerprint` was taken from. */
  static matches(fingerprint: string, candidate: string): boolean {
    const expected = Buffer.from(fingerprint, "utf8");
    const actual = Buffer.from(SecretCipher.fingerprint(candidate), "utf8");
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }
}

/** The AAD a given subscription's secrets are bound to. */
export function secretContext(tenantId: string, endpointId: string): string {
  return `tenant=${tenantId};endpoint=${endpointId}`;
}
