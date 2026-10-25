import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomInt } from "node:crypto";
import type { Db } from "./db.js";
import { type AccountDeps, checkNewEmail, checkPinRule, normalizeEmail, startEmailVerification } from "./accounts.js";
import { type Attestation, verifyAttestation } from "./attest.js";
import { type KeyAttestation, verifyKeyAttestation } from "./key-attest.js";
import { ApiError } from "./errors.js";
import { skeletonFree, validHandle } from "./handles.js";
import { inviterOf, returnInviteUse, takeInviteUse } from "./invites.js";
import type { Lang } from "./registry.js";
import { newSecret, secretHash } from "./secrets.js";
import { checkTermsVersion, recordTerms } from "./terms.js";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

// Matrix localparts are random and never shown (docs/usernames.md layer 1).
export function randomLocalpart(): string {
  return Array.from({ length: 12 }, () => BASE32[randomInt(32)]).join("");
}

export interface SignupInput {
  invite_code?: string;
  email?: string;
  password?: string;
  pin?: string;
  lang?: Lang;
  handle?: string;
  display_name?: string;
  attestation?: Attestation | KeyAttestation;
  signup_key?: string;
  terms_version?: string;
  account_type?: AccountType;
}

/** ADR 0087: a company account. It needs an attested device (ADR 0043) and does not count in the phone's cap (ADR 0086). */
export type AccountType = "personal" | "company";

// ADR 0094: a retry with the same signup_key gets the same account. Sealed copies live this long at most.
export const SIGNUP_REPLAY_DAYS = 7;
// Keys of sign-ups that run now. One API instance only, like the rate limits.
const running = new Set<string>();

/**
 * Two modes. Device-first (ADR 0057, ADR 0059): no password in the request. The server makes the hidden password
 * and a recovery token and returns both once; email is an optional recovery fallback, kept here and not in MAS.
 * Legacy (beta apps): email and password, both set in MAS as login, as before.
 */
/** Takes one account creation from the global allowance (bipe#395) and returns the function that gives it back. */
export type CreationSlot = () => () => void;

export async function signup(deps: AccountDeps, input: SignupInput, creation?: CreationSlot) {
  if (input.signup_key === undefined || input.password !== undefined) return createAccount(deps, input, null, creation);
  const key = input.signup_key;
  const keyHash = secretHash(key);
  // Check and add in one step (no await between), so two tries with one key cannot both create an account.
  if (running.has(keyHash)) throw new ApiError("rate_limited", "signup_in_progress");
  running.add(keyHash);
  try {
    return (await replaySignup(deps.db, key)) ?? (await createAccount(deps, input, key, creation));
  } finally {
    running.delete(keyHash);
  }
}

/** The answer of an earlier sign-up with this key, or null. Deletes a copy that no longer signs in. */
export async function replaySignup(db: Db, key: string) {
  const keyHash = secretHash(key);
  const { rows } = await db.query<{ user_id: string; sealed: Buffer; token_hash: string | null }>(
    `SELECT r.user_id, r.sealed, s.token_hash FROM signup_replays r
       LEFT JOIN account_secrets s ON s.user_id = r.user_id
      WHERE r.key_hash = $1 AND r.created_at > now() - make_interval(days => $2)`,
    [keyHash, SIGNUP_REPLAY_DAYS],
  );
  const row = rows[0];
  if (!row) return null;
  const secrets = openSealed(key, row.sealed);
  // A recovery on another device changed the credentials: this copy cannot sign in any more.
  if (!secrets || row.token_hash !== secretHash(secrets.recovery_token)) {
    await db.query("DELETE FROM signup_replays WHERE key_hash = $1", [keyHash]);
    return null;
  }
  const handle = await db.query<{ handle: string }>("SELECT handle FROM handles WHERE user_id = $1", [row.user_id]);
  const invite = await db.query<{ invite_id: string | null; account_type: string }>(
    "SELECT invite_id, account_type FROM signups WHERE user_id = $1",
    [row.user_id],
  );
  // ADR 0138 rule 2: a company account never names its owner's personal account, also for accounts made before bipe#513.
  const inviteId = invite.rows[0]?.account_type === "company" ? null : invite.rows[0]?.invite_id;
  const inviter = inviteId != null ? await inviterOf(db, Number(inviteId)) : null;
  return {
    user_id: row.user_id,
    ...(handle.rows[0] ? { handle: handle.rows[0].handle } : {}),
    ...(inviter ? { inviter_user_id: inviter } : {}),
    ...secrets,
  };
}

/** Called when the account reads GET /v1/me/account: the app has its credentials, so the sealed copy goes. */
export async function forgetSignupReplay(db: Db, userId: string): Promise<void> {
  await db.query("DELETE FROM signup_replays WHERE user_id = $1", [userId]);
}

export async function pruneSignupReplays(db: Db): Promise<number> {
  const { rowCount } = await db.query("DELETE FROM signup_replays WHERE created_at <= now() - make_interval(days => $1)", [SIGNUP_REPLAY_DAYS]);
  return rowCount ?? 0;
}

// AES-256-GCM under HKDF-SHA256(signup_key). Layout: 12-byte IV, 16-byte tag, ciphertext.
function sealKey(key: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(key, "utf8"), Buffer.alloc(0), "bipe-signup-replay-v1", 32));
}

function seal(key: string, secrets: { password: string; recovery_token: string }): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealKey(key), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(secrets), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function openSealed(key: string, sealed: Buffer): { password: string; recovery_token: string } | null {
  try {
    const decipher = createDecipheriv("aes-256-gcm", sealKey(key), sealed.subarray(0, 12));
    decipher.setAuthTag(sealed.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString("utf8");
    const value = JSON.parse(plain) as { password?: unknown; recovery_token?: unknown };
    if (typeof value.password !== "string" || typeof value.recovery_token !== "string") return null;
    return { password: value.password, recovery_token: value.recovery_token };
  } catch {
    console.error("signup: a sealed sign-up copy did not open");
    return null;
  }
}

/** True when the device is attested. Throws attestation_invalid for a proof that does not verify. */
function checkAttestation({ config, verifyKeyAttestation: verifyKey = verifyKeyAttestation }: AccountDeps, att: SignupInput["attestation"]): boolean {
  if (!att) return false;
  if ("key_attestation_chain" in att) {
    const result = verifyKey(att, {
      packages: config.ANDROID_ATTEST_PACKAGES,
      certDigests: config.ANDROID_ATTEST_CERT_DIGESTS,
      bootKeys: config.ANDROID_ATTEST_BOOT_KEYS,
    });
    if (!result.attested) console.log(`key attestation: not attested (${result.reason})`);
    return result.attested;
  }
  verifyAttestation(att, config.APP_ATTEST_APP_IDS, config.APP_ATTEST_ENVIRONMENT);
  return true;
}

async function createAccount(deps: AccountDeps, input: SignupInput, signupKey: string | null, creation?: CreationSlot) {
  const { db, mas, config } = deps;
  // Attestation first: it is the cheapest check that stops scripted sign-ups. A given attestation must be valid.
  // Android (bipe#92): a genuine chain from a phone that is not attested counts as no attestation (ADR 0043).
  if (!checkAttestation(deps, input.attestation) && (config.SIGNUP_ATTEST_REQUIRED || input.account_type === "company")) {
    throw new ApiError("attestation_invalid");
  }
  const accountType: AccountType = input.account_type ?? "personal";
  // ADR 0113: before anything is created. The row goes in with the signups row.
  const termsVersion = checkTermsVersion(input.terms_version, config.SIGNUP_TERMS_REQUIRED);

  const legacy = input.password !== undefined;
  if (legacy && input.email === undefined) throw new ApiError("bad_request", "email");
  if (legacy && accountType === "company") throw new ApiError("bad_request", "account_type");
  if (legacy && input.pin !== undefined) throw new ApiError("bad_request", "pin");
  const email = input.email !== undefined ? normalizeEmail(input.email) : null;
  const wanted = input.handle ? validHandle(input.handle, "") : null;
  if (wanted && !(await skeletonFree(db, wanted.skeleton, null))) throw new ApiError("handle_taken");
  if (legacy && (await mas.emailInUse(email!))) throw new ApiError("email_taken");
  if (!legacy && email) await checkNewEmail(deps, email, null);
  // Hash before anything is created: a weak PIN or a missing pepper must not leave an account behind.
  let pinHash: string | null = null;
  if (input.pin !== undefined) {
    checkPinRule(input.pin);
    pinHash = await deps.pins.hash(input.pin);
  }

  // A code is used when given, and required only when SIGNUP_INVITE_REQUIRED is on.
  const code = input.invite_code?.trim();
  const inviteId = code ? await takeInviteUse(db, code) : null;
  if (code && inviteId === null) throw new ApiError("invite_invalid");
  if (!code && config.SIGNUP_INVITE_REQUIRED) throw new ApiError("invite_invalid");
  // ADR 0138 rule 2 (bipe#513): the invite of a company sign-up comes from its owner's personal account on the phone.
  // The use counts against that quota, but the company account keeps no link to it: no invite_id, no inviter, no invite pair.
  const linkedInviteId = accountType === "company" ? null : inviteId;

  let masUserId: string | null = null;
  let giveBack: (() => void) | null = null;
  try {
    // bipe#395: every proof above passed. Only now does the sign-up take one of the hour's account creations.
    giveBack = creation?.() ?? null;
    let localpart = "";
    for (let attempt = 0; attempt < 3 && !masUserId; attempt++) {
      localpart = randomLocalpart();
      // Without a display name, clients fall back to the random Matrix ID. The handle is the next best name.
      masUserId = await mas.createUser(localpart, input.display_name?.trim() || wanted?.handle);
    }
    if (!masUserId) throw new ApiError("internal");
    const userId = `@${localpart}:${config.SERVER_NAME}`;

    let secrets: { password: string; recovery_token: string } | null = null;
    let sendVerification: (() => void) | null = null;
    if (legacy) {
      if (!(await mas.setPassword(masUserId, input.password!))) throw new ApiError("password_weak");
      if (!(await mas.addEmail(masUserId, email!))) throw new ApiError("email_taken");
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query("INSERT INTO signups (user_id, invite_id, account_type) VALUES ($1, $2, $3)", [userId, linkedInviteId, accountType]);
        if (termsVersion) await recordTerms(client, userId, termsVersion, "signup");
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    } else {
      // Returned once, never stored and never logged. Only the token's hash stays.
      const password = newSecret();
      const token = newSecret();
      if (!(await mas.setPassword(masUserId, password))) {
        console.error("signup: MAS refused a generated password");
        throw new ApiError("internal");
      }
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query("INSERT INTO signups (user_id, invite_id, account_type) VALUES ($1, $2, $3)", [userId, linkedInviteId, accountType]);
        if (termsVersion) await recordTerms(client, userId, termsVersion, "signup");
        await client.query(
          `INSERT INTO account_secrets (user_id, device_first, pin_hash, pin_set_at, token_hash, token_set_at)
           VALUES ($1, true, $2, CASE WHEN $2::text IS NULL THEN NULL ELSE now() END, $3, now())`,
          [userId, pinHash, secretHash(token)],
        );
        if (email) sendVerification = await startEmailVerification(deps, client, userId, email, input.lang ?? "pt");
        if (signupKey) {
          await client.query("INSERT INTO signup_replays (key_hash, user_id, sealed) VALUES ($1, $2, $3)", [
            secretHash(signupKey),
            userId,
            seal(signupKey, { password, recovery_token: token }),
          ]);
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
      secrets = { password, recovery_token: token };
    }

    let handle: string | undefined;
    if (wanted) {
      // A race can take the handle between the check and here. The account still stands; the user picks again.
      const res = await db.query(
        "INSERT INTO handles (user_id, handle, skeleton) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [userId, wanted.handle, wanted.skeleton],
      );
      if (res.rowCount === 1) handle = wanted.handle;
    }
    const inviter = linkedInviteId !== null ? await inviterOf(db, linkedInviteId) : null;
    sendVerification?.();
    // A replayed sign-up (ADR 0094) does not come here, so it does not count again.
    deps.growth?.record(userId, "signup_done");
    if (inviter) deps.growth?.record(inviter, "invite_redeemed");
    return {
      user_id: userId,
      ...(handle ? { handle } : {}),
      ...(inviter ? { inviter_user_id: inviter } : {}),
      ...(secrets ?? {}),
    };
  } catch (e) {
    giveBack?.();
    // Undo: MAS users cannot be deleted, only deactivated. Give the invite use back.
    if (masUserId) await mas.deactivate(masUserId).catch(() => console.error("signup: deactivate after failure failed"));
    if (signupKey) await db.query("DELETE FROM signup_replays WHERE key_hash = $1", [secretHash(signupKey)]).catch(() => {});
    if (inviteId !== null) await returnInviteUse(db, inviteId).catch(() => console.error("signup: invite refund failed"));
    throw e;
  }
}
