// ADR 0283 (bipe#1351): phones keep no hidden password. Each phone registers a hardware key (iOS Secure Enclave,
// Android Keystore) for its Matrix device. When the phone needs the password (link approval), the key signs a
// challenge and bipe-api sets a new random password through the MAS admin API and returns it once.
import { createPublicKey, verify, type KeyObject } from "node:crypto";
import type pg from "pg";
import type { AccountDeps } from "./accounts.js";
import { inTransaction, localpartOf } from "./accounts.js";
import { takeChallenge } from "./attest.js";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { newSecret } from "./secrets.js";

/** Domain tag of the signed message. bipe-shared test-vectors/device-keys.json has the reference bytes. */
export const PASSWORD_ONCE_TAG = "bipe-password-once:v1";

/** The bytes the device key signs: tag, user, device and challenge, one per line, UTF-8. */
export function passwordOnceMessage(userId: string, deviceId: string, challenge: string): Buffer {
  return Buffer.from(`${PASSWORD_ONCE_TAG}\n${userId}\n${deviceId}\n${challenge}`, "utf8");
}

/** A P-256 public key as base64 SubjectPublicKeyInfo DER, else bad_request. */
export function parseDeviceKey(base64: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(base64, "base64"), format: "der", type: "spki" });
  } catch {
    throw new ApiError("bad_request", "public_key");
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new ApiError("bad_request", "public_key");
  }
  return key;
}

/** ECDSA P-256 with SHA-256, DER signature (iOS ecdsaSignatureMessageX962SHA256, Android SHA256withECDSA). */
export function deviceSignatureValid(key: KeyObject, message: Buffer, signatureBase64: string): boolean {
  try {
    return verify("sha256", message, { key, dsaEncoding: "der" }, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

const spki = (key: KeyObject) => key.export({ type: "spki", format: "der" });

/**
 * POST /v1/me/device-key. The first key of a device stays: a second, different key is 409 device_key_exists, so a
 * stolen access token cannot replace the key of a phone that has one. The same key again is a no-op.
 */
export async function registerDeviceKey(db: Db, userId: string, deviceId: string, publicKey: string): Promise<void> {
  const der = spki(parseDeviceKey(publicKey));
  const { rows } = await db.query<{ public_key: Buffer }>(
    `INSERT INTO device_keys (user_id, device_id, public_key) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, device_id) DO UPDATE SET user_id = device_keys.user_id
     RETURNING public_key`,
    [userId, deviceId, der],
  );
  if (!rows[0]!.public_key.equals(der)) throw new ApiError("device_key_exists");
}

/**
 * POST /v1/me/password-once. The key of this device signs passwordOnceMessage over a challenge from
 * POST /v1/me/password-once/challenge. One request at a time per account (account_secrets row lock), so two phones
 * cannot race on the MAS password. Logs each use without the secret (ADR 0283 decision 7). Returns the password once.
 */
export async function passwordOnce(
  deps: AccountDeps,
  userId: string,
  deviceId: string,
  challenge: string,
  signature: string,
): Promise<{ password: string }> {
  const { rows } = await deps.db.query<{ public_key: Buffer }>(
    "SELECT public_key FROM device_keys WHERE user_id = $1 AND device_id = $2",
    [userId, deviceId],
  );
  const row = rows[0];
  if (!row) throw new ApiError("device_key_missing");
  // The challenge is spent before the signature check: a wrong signature cannot try again with it.
  if (!takeChallenge(challenge)) throw new ApiError("signature_invalid");
  const key = createPublicKey({ key: row.public_key, format: "der", type: "spki" });
  if (!deviceSignatureValid(key, passwordOnceMessage(userId, deviceId, challenge), signature)) {
    throw new ApiError("signature_invalid");
  }
  const password = await inTransaction(deps.db, async (client: pg.PoolClient) => {
    const { rows: secrets } = await client.query<{ device_first: boolean }>(
      "SELECT device_first FROM account_secrets WHERE user_id = $1 FOR UPDATE",
      [userId],
    );
    // ADR 0283 decision 9: a beta account keeps the password its person chose.
    if (!secrets[0]?.device_first) throw new ApiError("device_first_required");
    const masUser = await deps.mas.userByUsername(localpartOf(deps.config, userId));
    if (!masUser) throw new ApiError("not_found");
    const fresh = newSecret();
    if (!(await deps.mas.setPassword(masUser.id, fresh))) {
      console.error("password-once: MAS refused a generated password");
      throw new ApiError("internal");
    }
    await client.query(
      "UPDATE device_keys SET last_used_at = now(), uses = uses + 1 WHERE user_id = $1 AND device_id = $2",
      [userId, deviceId],
    );
    return fresh;
  });
  console.log(`password-once: issued for one device (uses counted in device_keys)`);
  return { password };
}
