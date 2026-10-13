// "Quem pode me mandar mensagem" (docs/usernames.md "First contact"). The Synapse module
// bipe_messaging asks POST /internal/v1/may-invite before every invite and blocks a "false".
import { timingSafeEqual } from "node:crypto";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";

export const POLICIES = ["everyone", "verified", "contacts"] as const;
export type Policy = (typeof POLICIES)[number];

export async function policyOf(db: Db, userId: string): Promise<Policy> {
  const { rows } = await db.query<{ policy: Policy }>("SELECT policy FROM messaging_policies WHERE user_id = $1", [userId]);
  return rows[0]?.policy ?? "everyone";
}

export async function setPolicy(db: Db, userId: string, policy: Policy): Promise<void> {
  await db.query(
    `INSERT INTO messaging_policies (user_id, policy) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET policy = EXCLUDED.policy, updated_at = now()`,
    [userId, policy],
  );
}

/** Invite pairs trust each other (ADR 0034): one of the two joined with the other's invite. */
async function invitePair(db: Db, a: string, b: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM signups s JOIN invites i ON i.id = s.invite_id
     WHERE (s.user_id = $1 AND i.created_by = $2) OR (s.user_id = $2 AND i.created_by = $1) LIMIT 1`,
    [a, b],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Contacts (a shared joined room or an invite pair) may always invite.
 * "verified" also admits verified accounts; no account is verified yet, so it acts like "contacts".
 */
export async function mayInvite(db: Db, inviter: string, invitee: string, sharesRoom: boolean) {
  const policy = await policyOf(db, invitee);
  if (policy === "everyone" || sharesRoom) return { allow: true, policy };
  if (await invitePair(db, inviter, invitee)) return { allow: true, policy };
  return { allow: false, policy };
}

/** Constant-time check of the shared secret that only the Synapse module holds. */
export function checkInternal(header: string | undefined, secret: string): void {
  const a = Buffer.from(header ?? "");
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ApiError("unauthorized");
}
