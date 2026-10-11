import { randomInt } from "node:crypto";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { skeletonFree, validHandle } from "./handles.js";
import { returnInviteUse, takeInviteUse } from "./invites.js";
import type { Mas } from "./mas.js";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

// Matrix localparts are random and never shown (docs/usernames.md layer 1).
export function randomLocalpart(): string {
  return Array.from({ length: 12 }, () => BASE32[randomInt(32)]).join("");
}

export interface SignupInput {
  invite_code: string;
  email: string;
  password: string;
  handle?: string;
  display_name?: string;
}

export async function signup(db: Db, mas: Mas, config: Config, input: SignupInput) {
  const email = input.email.trim().toLowerCase();
  const wanted = input.handle ? validHandle(input.handle) : null;
  if (wanted && !(await skeletonFree(db, wanted.skeleton, null))) throw new ApiError("handle_taken");
  if (await mas.emailInUse(email)) throw new ApiError("email_taken");

  const inviteId = await takeInviteUse(db, input.invite_code);
  if (inviteId === null) throw new ApiError("invite_invalid");

  let masUserId: string | null = null;
  try {
    let localpart = "";
    for (let attempt = 0; attempt < 3 && !masUserId; attempt++) {
      localpart = randomLocalpart();
      masUserId = await mas.createUser(localpart, input.display_name?.trim() || undefined);
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
    return { user_id: userId, ...(handle ? { handle } : {}) };
  } catch (e) {
    // Undo: MAS users cannot be deleted, only deactivated. Give the invite use back.
    if (masUserId) await mas.deactivate(masUserId).catch(() => console.error("signup: deactivate after failure failed"));
    await returnInviteUse(db, inviteId).catch(() => console.error("signup: invite refund failed"));
    throw e;
  }
}
