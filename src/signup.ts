import { randomInt } from "node:crypto";
import { type AccountDeps, checkNewEmail, checkPinRule, normalizeEmail, startEmailVerification } from "./accounts.js";
import { type Attestation, verifyAttestation } from "./attest.js";
import { ApiError } from "./errors.js";
import { skeletonFree, validHandle } from "./handles.js";
import { inviterOf, returnInviteUse, takeInviteUse } from "./invites.js";
import type { Lang } from "./registry.js";
import { newSecret, secretHash } from "./secrets.js";

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
  attestation?: Attestation;
}

/**
 * Two modes. Device-first (ADR 0057, ADR 0059): no password in the request. The server makes the hidden password
 * and a recovery token and returns both once; email is an optional recovery fallback, kept here and not in MAS.
 * Legacy (beta apps): email and password, both set in MAS as login, as before.
 */
export async function signup(deps: AccountDeps, input: SignupInput) {
  const { db, mas, config } = deps;
  // App Attest first: it is the cheapest check that stops scripted sign-ups. A given attestation must be valid.
  if (input.attestation) verifyAttestation(input.attestation, config.APP_ATTEST_APP_IDS);
  else if (config.SIGNUP_ATTEST_REQUIRED) throw new ApiError("attestation_invalid");

  const legacy = input.password !== undefined;
  if (legacy && input.email === undefined) throw new ApiError("bad_request", "email");
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

  let masUserId: string | null = null;
  try {
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
      await db.query("INSERT INTO signups (user_id, invite_id) VALUES ($1, $2)", [userId, inviteId]);
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
        await client.query("INSERT INTO signups (user_id, invite_id) VALUES ($1, $2)", [userId, inviteId]);
        await client.query(
          `INSERT INTO account_secrets (user_id, device_first, pin_hash, pin_set_at, token_hash, token_set_at)
           VALUES ($1, true, $2, CASE WHEN $2::text IS NULL THEN NULL ELSE now() END, $3, now())`,
          [userId, pinHash, secretHash(token)],
        );
        if (email) sendVerification = await startEmailVerification(deps, client, userId, email, input.lang ?? "pt");
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
    const inviter = inviteId !== null ? await inviterOf(db, inviteId) : null;
    sendVerification?.();
    return {
      user_id: userId,
      ...(handle ? { handle } : {}),
      ...(inviter ? { inviter_user_id: inviter } : {}),
      ...(secrets ?? {}),
    };
  } catch (e) {
    // Undo: MAS users cannot be deleted, only deactivated. Give the invite use back.
    if (masUserId) await mas.deactivate(masUserId).catch(() => console.error("signup: deactivate after failure failed"));
    if (inviteId !== null) await returnInviteUse(db, inviteId).catch(() => console.error("signup: invite refund failed"));
    throw e;
  }
}
