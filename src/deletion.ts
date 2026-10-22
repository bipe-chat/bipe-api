import type { AccountDeps } from "./accounts.js";
import { verifyPin } from "./accounts.js";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { removeHandle } from "./handles.js";
import { accountRules } from "./registry.js";
import type { StateEvent, SynapseAdmin } from "./synapse-admin.js";

// In-app account deletion (ADR 0140, bipe-chat/bipe#528).
// - The app runs the device owner check, then sends the PIN. The PIN check is verifyPin(), so wrong
//   PINs count with every recovery path.
// - The request waits deletionCooldownHours (registries/accounts.json). Every signed-in device sees
//   it in GET /v1/me/account and can cancel.
// - runDueDeletions() runs only in the deletion CronJob (node dist/cli.js deletion run), the one
//   process with the Synapse admin client. It hands owned groups on, redacts when asked, holds the
//   @ (releaseHoldDays), deletes the account's records and deactivates the account in MAS.
// - What stays: the CNPJ claim (badge record) in business_claims. Bipe has no CPF verification yet,
//   so no CPF hash exists to keep.

export interface DeletionRow {
  created_at: Date;
  due_at: Date;
  redact_messages: boolean;
}

export const deletionJson = (r: DeletionRow) => ({
  created_at: r.created_at.toISOString(),
  due_at: r.due_at.toISOString(),
  redact_messages: r.redact_messages,
});

/** The waiting deletion of an account, or null. */
export async function waitingDeletion(db: Db, userId: string): Promise<DeletionRow | null> {
  const { rows } = await db.query<DeletionRow>(
    "SELECT created_at, due_at, redact_messages FROM account_deletions WHERE user_id = $1 AND state = 'waiting'",
    [userId],
  );
  return rows[0] ?? null;
}

/** Starts the wait. A second request while one waits returns the waiting one and changes nothing. */
export async function requestDeletion(deps: AccountDeps, userId: string, pin: string, redactMessages: boolean): Promise<DeletionRow> {
  const waiting = await waitingDeletion(deps.db, userId);
  if (waiting) return waiting;
  await verifyPin(deps, userId, pin);
  const { rows } = await deps.db.query<DeletionRow>(
    `INSERT INTO account_deletions (user_id, due_at, redact_messages)
     VALUES ($1, now() + make_interval(hours => $2), $3)
     ON CONFLICT (user_id) DO UPDATE SET created_at = now(), due_at = EXCLUDED.due_at,
       redact_messages = EXCLUDED.redact_messages, state = 'waiting', ended_at = NULL
     WHERE account_deletions.state <> 'waiting'
     RETURNING created_at, due_at, redact_messages`,
    [userId, accountRules.deletionCooldownHours, redactMessages],
  );
  // A parallel request won the insert: return its row.
  return rows[0] ?? (await waitingDeletion(deps.db, userId))!;
}

/** Any signed-in device of the account cancels until due_at. */
export async function cancelDeletion(db: Db, userId: string): Promise<void> {
  const res = await db.query(
    // The row goes: the register (bipe-shared data.json) keeps the request only until a cancel.
    "DELETE FROM account_deletions WHERE user_id = $1 AND state = 'waiting'",
    [userId],
  );
  if (res.rowCount !== 1) throw new ApiError("not_found");
}

// --- The CronJob ---------------------------------------------------------------------------------

// Rows of this API that belong to the account and go with it. business_claims (the badge record)
// stays. handles goes through removeHandle(), which writes the hold and the change line.
const DELETED_TABLES = [
  "account_secrets",
  "recovery_emails",
  "recoveries",
  "phone_links",
  "discovery_settings",
  "messaging_policies",
  "public_profiles",
  "invite_grants",
  "signup_replays",
  "support_rooms",
] as const;

/** Runs every deletion whose wait is over. Returns how many finished and how many failed. */
export async function runDueDeletions(deps: AccountDeps, synapse: SynapseAdmin): Promise<{ done: number; failed: number }> {
  let done = 0, failed = 0;
  for (;;) {
    // One at a time, so two CronJob runs never take the same account.
    const { rows } = await deps.db.query<{ user_id: string; redact_messages: boolean }>(
      `UPDATE account_deletions SET state = 'running'
       WHERE user_id = (SELECT user_id FROM account_deletions WHERE state = 'waiting' AND due_at <= now()
                        ORDER BY due_at LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING user_id, redact_messages`,
    );
    const row = rows[0];
    if (!row) break;
    try {
      await deleteAccount(deps, synapse, row.user_id, row.redact_messages);
      await deps.db.query("DELETE FROM account_deletions WHERE user_id = $1", [row.user_id]);
      done++;
    } catch (e) {
      // No user ID next to the error text. A failed row stays for staff and is not retried by itself.
      console.error(`deletion: one account failed: ${(e as Error).message}`);
      await deps.db.query("UPDATE account_deletions SET state = 'failed', ended_at = now() WHERE user_id = $1", [row.user_id]);
      failed++;
    }
  }
  return { done, failed };
}

async function deleteAccount(deps: AccountDeps, synapse: SynapseAdmin, userId: string, redact: boolean): Promise<void> {
  // 1. Groups first, while the account is still a member and an admin.
  for (const roomId of await synapse.joinedRooms(userId)) {
    const heir = successor(await synapse.roomState(roomId), userId);
    if (heir) await synapse.makeRoomAdmin(roomId, heir);
  }
  // 2. Redaction runs in the background in Synapse; it keeps working after the deactivation.
  if (redact) await synapse.redactAll(userId);
  // 3. The @ on hold, then this API's records.
  await removeHandle(deps.db, userId);
  for (const table of DELETED_TABLES) await deps.db.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
  // 4. Last: the account itself. MAS deactivates it in Synapse too.
  const local = userId.slice(1).split(":")[0] ?? "";
  const masUser = await deps.mas.userByUsername(local);
  if (masUser) await deps.mas.deactivate(masUser.id);
}

/**
 * Who takes over a group the leaving account owns: the oldest other admin, else the oldest other
 * member (ADR 0140, point 5). Null when the account is not the only top-level admin, or when the
 * room is a DM or has no other member.
 */
export function successor(state: StateEvent[], userId: string): string | null {
  const joined = state.filter((e) => e.type === "m.room.member" && e.content.membership === "join" && e.state_key !== userId);
  if (joined.length < 2) return null; // a DM or an empty room: nothing to hand on
  const pl = state.find((e) => e.type === "m.room.power_levels" && e.state_key === "")?.content ?? {};
  const users: Record<string, number> = pl.users ?? {};
  const levelOf = (u: string) => users[u] ?? pl.users_default ?? 0;
  const top = Math.max(levelOf(userId), ...joined.map((e) => levelOf(e.state_key)));
  if (levelOf(userId) < top) return null; // someone else already outranks the account
  if (joined.some((e) => levelOf(e.state_key) >= top)) return null; // another top admin stays
  const byAge = [...joined].sort((a, b) => a.origin_server_ts - b.origin_server_ts);
  const admins = byAge.filter((e) => levelOf(e.state_key) >= (pl.state_default ?? 50));
  return (admins[0] ?? byAge[0])?.state_key ?? null;
}
