import { randomInt } from "node:crypto";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { type Attestation, verifyAttestation } from "./attest.js";
import { ApiError } from "./errors.js";
import { skeletonFree, validHandle } from "./handles.js";
import { inviterOf, returnInviteUse, takeInviteUse } from "./invites.js";
import type { Mas } from "./mas.js";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

// Matrix localparts are random and never shown (docs/usernames.md layer 1).
export function randomLocalpart(): string {
  return Array.from({ length: 12 }, () => BASE32[randomInt(32)]).join("");
}

export interface SignupInput {
  invite_code?: string;
  email: string;
  password: string;
  handle?: string;
  display_name?: string;
  attestation?: Attestation;
}

export async function signup(db: Db, mas: Mas, config: Config, input: SignupInput) {
  // App Attest first: it is the cheapest check that stops scripted sign-ups. A given attestation must be valid.
  if (input.attestation) verifyAttestation(input.attestation, config.APP_ATTEST_APP_IDS);
  else if (config.SIGNUP_ATTEST_REQUIRED) throw new ApiError("attestation_invalid");

  const email = input.email.trim().toLowerCase();
  const wanted = input.handle ? validHandle(input.handle) : null;
  if (wanted && !(await skeletonFree(db, wanted.skeleton, null))) throw new ApiError("handle_taken");
  if (await mas.emailInUse(email)) throw new ApiError("email_taken");

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
    if (!(await mas.setPassword(masUserId, input.password))) throw new ApiError("password_weak");
    if (!(await mas.addEmail(masUserId, email))) throw new ApiError("email_taken");

    const userId = `@${localpart}:${config.SERVER_NAME}`;
    await db.query("INSERT INTO signups (user_id, invite_id) VALUES ($1, $2)", [userId, inviteId]);

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
    return { user_id: userId, ...(handle ? { handle } : {}), ...(inviter ? { inviter_user_id: inviter } : {}) };
  } catch (e) {
    // Undo: MAS users cannot be deleted, only deactivated. Give the invite use back.
    if (masUserId) await mas.deactivate(masUserId).catch(() => console.error("signup: deactivate after failure failed"));
    if (inviteId !== null) await returnInviteUse(db, inviteId).catch(() => console.error("signup: invite refund failed"));
    throw e;
  }
}
