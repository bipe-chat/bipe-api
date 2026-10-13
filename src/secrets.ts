import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { ApiError } from "./errors.js";

// Device-first accounts (ADR 0057, ADR 0059). Secrets the API hands out once and never stores in clear.

/** 32 random bytes as base64url (43 characters): hidden passwords, recovery tokens, link tokens, claim secrets. */
export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** Shape of newSecret() output. Checked before any lookup. */
export const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Lookup hash for a high-entropy secret. A fast hash is enough: the input has 256 random bits. */
export function secretHash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function sameSecret(secret: string, storedHash: string): boolean {
  const a = Buffer.from(secretHash(secret), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// PIN hash. Input to scrypt: HMAC-SHA256(key = BIPE_PIN_PEPPER, message = PIN). Then scrypt with a 16-byte
// random salt per hash, N = 2^15, r = 8, p = 1 (32 MiB, tens of milliseconds), 32-byte output.
// Stored as "scrypt1$<salt>$<hash>" (base64url), so the parameters can change with a new prefix.
// With the database alone, nobody can test a PIN: every guess needs the pepper. With the database and the
// pepper, an attacker can try all 10^8 PINs offline at one scrypt each (accepted risk, ADR 0059).
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const PREFIX = "scrypt1";

export class PinHasher {
  private readonly pepper?: Buffer;

  constructor(pepperHex: string | undefined) {
    if (pepperHex) this.pepper = Buffer.from(pepperHex, "hex");
  }

  async hash(pin: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await this.derive(pin, salt);
    return `${PREFIX}$${salt.toString("base64url")}$${key.toString("base64url")}`;
  }

  async verify(pin: string, stored: string): Promise<boolean> {
    const [prefix, salt, hash] = stored.split("$");
    if (prefix !== PREFIX || !salt || !hash) {
      console.error("pins: stored hash has an unknown format");
      throw new ApiError("internal");
    }
    const expected = Buffer.from(hash, "base64url");
    const key = await this.derive(pin, Buffer.from(salt, "base64url"));
    return key.length === expected.length && timingSafeEqual(key, expected);
  }

  private derive(pin: string, salt: Buffer): Promise<Buffer> {
    if (!this.pepper) {
      console.error("pins: BIPE_PIN_PEPPER is not set");
      throw new ApiError("internal");
    }
    const peppered = createHmac("sha256", this.pepper).update(pin, "utf8").digest();
    return new Promise((resolve, reject) => scrypt(peppered, salt, 32, SCRYPT, (err, key) => (err ? reject(err) : resolve(key))));
  }
}
