import { randomBytes } from "node:crypto";
import { notify, verifyPin, type AccountDeps } from "./accounts.js";
import { forgetBugReports } from "./bug-reports.js";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { removeHandle } from "./handles.js";
import { accountRules, appString } from "./registry.js";
import { type StateEvent, type SynapseAdminApi, SynapseHttpError } from "./synapse-admin.js";

// Account deletion (ADR 0140, bipe#528). The request needs the device owner check on the phone and the senha, which
// this file checks. The account works for deletionCooldownHours; any signed-in device can cancel. At due_at the job:
//   1. groups:  hands each room the user owns to the oldest admin, else the oldest member (Synapse admin API);
//   2. redact:  redacts the user's events when asked, and waits for Synapse to finish;
//   3. mas:     deactivates the MAS user (no more sign-in);
//   4. synapse: deactivates and erases the Synapse user (idempotent);
//   5. rows:    puts the @ on hold, deletes this API's rows about the user, keeps only the CPF hash and the badge record.
// Each step is idempotent, and the row keeps the last finished step, so a failed step runs again on a later tick.
// Logs carry the request id, the step and an HTTP status, never a user ID, a room or a body.

export interface DeletionDeps extends AccountDeps {
  /** Null without SYNAPSE_ADMIN_TOKEN: requests wait, the job runs none. */
  synapse: SynapseAdminApi | null;
  bugReportsDir: string;
  /** Accounts that never get a room handed over (the support and news bots). */
  serviceUsers?: string[];
}

type Ready = DeletionDeps & { synapse: SynapseAdminApi };

export interface AccountDeletion {
  id: string;
  created_at: string;
  due_at: string;
  redact_messages: boolean;
  from_this_device: boolean;
}

interface DeletionRow {
  id: string;
  user_id: string;
  device_id: string | null;
  redact_messages: boolean;
  state: "waiting" | "running" | "done";
  created_at: Date;
  due_at: Date;
  step: Step | null;
  redact_id: string | null;
  tries: number;
}

const STEPS = ["groups", "redact", "mas", "synapse", "rows"] as const;
type Step = (typeof STEPS)[number];

// A claimed row is not picked again for this long, so a slow run and the next tick do not overlap.
const LEASE_MINUTES = 15;
// Synapse redacts in the background; the job looks again after this long.
const REDACT_POLL_MINUTES = 1;
const MAX_PER_TICK = 10;

const newId = () => randomBytes(16).toString("base64url");

const shown = (row: DeletionRow, deviceId: string | null): AccountDeletion => ({
  id: row.id,
  created_at: row.created_at.toISOString(),
  due_at: row.due_at.toISOString(),
  redact_messages: row.redact_messages,
  from_this_device: deviceId !== null && row.device_id === deviceId,
});

/** The waiting request of the account, for GET /v1/me/account. Null when none, or when the job owns it now. */
export async function pendingDeletion(db: Db, userId: string, deviceId: string | null): Promise<AccountDeletion | null> {
  const { rows } = await db.query<DeletionRow>(
    "SELECT * FROM account_deletions WHERE user_id = $1 AND state = 'waiting' AND due_at > now()",
    [userId],
  );
  return rows[0] ? shown(rows[0], deviceId) : null;
}

/** POST /v1/me/deletion. A waiting request answers deletion_pending before the PIN is read, so it costs no try. */
export async function requestDeletion(
  deps: AccountDeps,
  userId: string,
  deviceId: string | null,
  pin: string,
  redactMessages: boolean,
): Promise<AccountDeletion> {
  const open = await deps.db.query("SELECT 1 FROM account_deletions WHERE user_id = $1 AND state IN ('waiting', 'running')", [userId]);
  if (open.rows.length > 0) throw new ApiError("deletion_pending");
  await verifyPin(deps, userId, pin);
  let row: DeletionRow;
  try {
    const res = await deps.db.query<DeletionRow>(
      `INSERT INTO account_deletions (id, user_id, device_id, redact_messages, state, due_at)
       VALUES ($1, $2, $3, $4, 'waiting', now() + make_interval(hours => $5)) RETURNING *`,
      [newId(), userId, deviceId, redactMessages, accountRules.deletionCooldownHours],
    );
    row = res.rows[0]!;
  } catch (e) {
    // A second request of the same account got in first (unique index on open requests).
    if ((e as { code?: string }).code === "23505") throw new ApiError("deletion_pending");
    throw e;
  }
  console.log(`deletion: requested id=${row.id}`);
  await notify(deps, userId, "bipe_mail_notice_deletion_started", row.due_at);
  return shown(row, deviceId);
}

/** POST /v1/me/deletions/{id}/cancel: any signed-in device of the account, until due_at. The row goes. */
export async function cancelDeletion(deps: AccountDeps, userId: string, id: string): Promise<void> {
  const res = await deps.db.query(
    "DELETE FROM account_deletions WHERE id = $1 AND user_id = $2 AND state = 'waiting' AND due_at > now()",
    [id, userId],
  );
  if (res.rowCount !== 1) throw new ApiError("not_found");
  console.log(`deletion: cancelled id=${id}`);
  await notify(deps, userId, "bipe_mail_notice_deletion_cancelled");
}

// --- The job -----------------------------------------------------------------------------------------

let busy = false;

/** One tick: runs the due requests, oldest first. Returns how many finished. */
export async function runDueDeletions(deps: DeletionDeps): Promise<number> {
  if (busy || !deps.synapse) return 0;
  busy = true;
  let finished = 0;
  try {
    for (let i = 0; i < MAX_PER_TICK; i++) {
      const row = await claim(deps.db);
      if (!row) break;
      if (await runOne({ ...deps, synapse: deps.synapse }, row)) finished++;
    }
  } finally {
    busy = false;
  }
  return finished;
}

async function claim(db: Db): Promise<DeletionRow | null> {
  const { rows } = await db.query<DeletionRow>(
    `UPDATE account_deletions SET state = 'running', tries = tries + 1, next_try_at = now() + make_interval(mins => $1)
     WHERE id = (
       SELECT id FROM account_deletions
       WHERE state IN ('waiting', 'running') AND due_at <= now() AND (next_try_at IS NULL OR next_try_at <= now())
       ORDER BY due_at LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [LEASE_MINUTES],
  );
  return rows[0] ?? null;
}

class Later extends Error {}

async function runOne(deps: Ready, row: DeletionRow): Promise<boolean> {
  let step: Step = STEPS[row.step ? STEPS.indexOf(row.step) + 1 : 0] ?? "rows";
  try {
    for (let i = STEPS.indexOf(step); i < STEPS.length; i++) {
      step = STEPS[i]!;
      await runStep(deps, row, step);
      await deps.db.query("UPDATE account_deletions SET step = $2, last_error = NULL WHERE id = $1", [row.id, step]);
      row.step = step;
    }
    await deps.db.query(
      `UPDATE account_deletions SET state = 'done', done_at = now(), device_id = NULL, redact_id = NULL, next_try_at = NULL,
         last_error = NULL WHERE id = $1`,
      [row.id],
    );
    console.log(`deletion: done id=${row.id}`);
    return true;
  } catch (e) {
    if (e instanceof Later) {
      // Waiting for Synapse is not a failed try.
      await deps.db.query(
        "UPDATE account_deletions SET tries = greatest(tries - 1, 0), next_try_at = now() + make_interval(mins => $2) WHERE id = $1",
        [row.id, REDACT_POLL_MINUTES],
      );
      return false;
    }
    const status = e instanceof SynapseHttpError ? `synapse ${e.what} ${e.status}` : e instanceof ApiError ? e.id : "error";
    // Back off: 2, 4, 8 ... minutes, at most 6 hours. The request never gives up: staff see it in `deletion status`.
    const minutes = Math.min(2 ** Math.min(row.tries, 9), 360);
    await deps.db.query(
      "UPDATE account_deletions SET last_error = $2, next_try_at = now() + make_interval(mins => $3) WHERE id = $1",
      [row.id, `${step}: ${status}`, minutes],
    );
    console.error(`deletion: ALERT step ${step} failed id=${row.id} try=${row.tries} (${status})`);
    return false;
  }
}

async function runStep(deps: Ready, row: DeletionRow, step: Step): Promise<void> {
  switch (step) {
    case "groups":
      await handOverRooms(deps, row);
      return;
    case "redact":
      if (row.redact_messages) await redact(deps, row);
      return;
    case "mas": {
      const user = await deps.mas.userState(localpart(row.user_id));
      if (user && !user.deactivated) await deps.mas.deactivate(user.id);
      return;
    }
    case "synapse":
      await deps.synapse.deactivate(row.user_id);
      return;
    case "rows":
      await deleteRows(deps, row.user_id);
      return;
  }
}

function localpart(userId: string): string {
  const m = /^@([^:]+):/.exec(userId);
  if (!m) throw new ApiError("internal");
  return m[1]!;
}

async function handOverRooms(deps: Ready, row: DeletionRow): Promise<void> {
  const skip = new Set(deps.serviceUsers ?? []);
  let handed = 0;
  for (const roomId of await deps.synapse.joinedRooms(row.user_id)) {
    const target = nextOwner(await deps.synapse.roomState(roomId), row.user_id, skip);
    if (!target) continue;
    await deps.synapse.makeRoomAdmin(roomId, target);
    handed++;
  }
  if (handed > 0) console.log(`deletion: rooms handed over id=${row.id} count=${handed}`);
}

async function redact(deps: Ready, row: DeletionRow): Promise<void> {
  if (!row.redact_id) {
    const redactId = await deps.synapse.redactUser(row.user_id);
    await deps.db.query("UPDATE account_deletions SET redact_id = $2 WHERE id = $1", [row.id, redactId]);
    row.redact_id = redactId;
  }
  const { status, failed } = await deps.synapse.redactStatus(row.redact_id);
  if (status === "scheduled" || status === "active") throw new Later();
  if (status === "failed") {
    // Start again on the next try: a new task redacts what is left.
    await deps.db.query("UPDATE account_deletions SET redact_id = NULL WHERE id = $1", [row.id]);
    row.redact_id = null;
    throw new SynapseHttpError("redact_status", 200);
  }
  if (failed > 0) console.error(`deletion: ALERT redaction left ${failed} events id=${row.id}`);
}

/**
 * The member who gets the room when the leaving user owns it, or null. The user owns the room when no other joined
 * member has a power level as high (room version 12 creators count as above every level). Then: the oldest admin
 * (power level 50 or more), else the oldest member. "Oldest" is the time of the member's current membership event:
 * the room state has no join history.
 */
export function nextOwner(state: StateEvent[], userId: string, skip: Set<string> = new Set()): string | null {
  const create = state.find((e) => e.type === "m.room.create" && e.state_key === "");
  const power = state.find((e) => e.type === "m.room.power_levels" && e.state_key === "")?.content as
    | { users?: Record<string, number>; users_default?: number }
    | undefined;
  const version = String(create?.content.room_version ?? "1");
  const creators = new Set<string>();
  if (/^\d+$/.test(version) && Number(version) >= 12 && create) {
    creators.add(create.sender);
    const extra = create.content.additional_creators;
    if (Array.isArray(extra)) for (const u of extra) if (typeof u === "string") creators.add(u);
  }
  const level = (u: string): number => {
    if (creators.has(u)) return Number.POSITIVE_INFINITY;
    if (!power) return u === create?.sender ? 100 : 0;
    const v = power.users?.[u] ?? power.users_default ?? 0;
    return typeof v === "number" ? v : 0;
  };
  const own = level(userId);
  if (own < 100) return null;
  const members = state
    .filter((e) => e.type === "m.room.member" && e.state_key !== userId && e.content.membership === "join" && !skip.has(e.state_key))
    .sort((a, b) => a.origin_server_ts - b.origin_server_ts || a.state_key.localeCompare(b.state_key));
  if (members.length === 0) return null;
  const allJoined = state.filter((e) => e.type === "m.room.member" && e.state_key !== userId && e.content.membership === "join");
  if (allJoined.some((e) => level(e.state_key) >= own)) return null;
  return (members.find((e) => level(e.state_key) >= 50) ?? members[0]!).state_key;
}

/** Step rows: one transaction for this API's rows, then the problem report files and the growth rows. */
async function deleteRows(deps: DeletionDeps, userId: string): Promise<void> {
  // ADR 0016: the @ is held for releaseHoldDays, as for a released handle. A second run finds no handle. The rows in
  // handle_holds stay until they end: they are the hold.
  await removeHandle(deps.db, userId);
  const label = appString("pt", "bipe_deletion_customer_name");
  const client = await deps.db.connect();
  try {
    await client.query("BEGIN");
    const q = (sql: string, args: unknown[] = [userId]) => client.query(sql, args);
    // Business tools of a company account (ADR 0102 to 0107): the records go with the account.
    await q("DELETE FROM bookings WHERE business_id = $1");
    await q("DELETE FROM agenda_overrides WHERE business_id = $1");
    await q("DELETE FROM agendas WHERE business_id = $1");
    await q("DELETE FROM agenda_settings WHERE business_id = $1");
    await q("DELETE FROM queues WHERE business_id = $1");
    await q("DELETE FROM queue_settings WHERE business_id = $1");
    await q("DELETE FROM quotes WHERE business_id = $1 OR customer_id = $1");
    await q("DELETE FROM quote_requests WHERE business_id = $1 OR customer_id = $1");
    await q("DELETE FROM orders WHERE business_id = $1");
    await q("DELETE FROM order_settings WHERE business_id = $1");
    await q("DELETE FROM catalog_items WHERE business_id = $1");
    // The user as a customer of other businesses: they keep the record without the account (product/data.json).
    await q(
      `UPDATE bookings SET customer_id = NULL, customer_name = $2, updated_at = now(),
         status = CASE WHEN status IN ('held', 'requested', 'confirmed') THEN 'cancelled' ELSE status END,
         ended_reason = CASE WHEN status IN ('held', 'requested', 'confirmed') THEN 'account_deleted' ELSE ended_reason END
       WHERE customer_id = $1`,
      [userId, label],
    );
    await q(
      `UPDATE orders SET customer_id = NULL, customer_name = $2, updated_at = now(),
         status = CASE WHEN status IN ('sent', 'accepted', 'ready') THEN 'cancelled' ELSE status END
       WHERE customer_id = $1`,
      [userId, label],
    );
    await q(
      `UPDATE queue_places SET customer_id = NULL, customer_name = $2,
         status = CASE WHEN status IN ('waiting', 'called') THEN 'left' ELSE status END
       WHERE customer_id = $1`,
      [userId, label],
    );
    // Brand marks (ADR 0162): a mark ends with either account, so the deletion removes the user's marks as brand or
    // reseller, the invites they made and the events they did. Events of the other party keep only that party's ID.
    await q("DELETE FROM brand_marks WHERE brand_user_id = $1 OR reseller_user_id = $1");
    await q("DELETE FROM brand_mark_invites WHERE brand_user_id = $1");
    await q("DELETE FROM brand_mark_events WHERE actor_user_id = $1");
    // Theft protection (ADR 0044, ADR 0051): the user's guardians, guardian roles, phone IDs and marks go. Marks the
    // user made or cleared for someone else stay for that account, without the user's ID.
    await q("DELETE FROM guardians WHERE owner_id = $1 OR guardian_id = $1");
    await q("DELETE FROM account_phones WHERE user_id = $1");
    await q("UPDATE theft_marks SET root_id = NULL WHERE root_id IN (SELECT id FROM theft_marks WHERE user_id = $1)");
    await q("DELETE FROM theft_marks WHERE user_id = $1");
    await q("UPDATE theft_marks SET marked_by = 'deleted' WHERE marked_by = $1");
    await q("UPDATE theft_marks SET cleared_by = 'deleted' WHERE cleared_by = $1");
    // Invites the user made stay for the people who joined with them, without the maker.
    await q("UPDATE invites SET created_by = NULL, name = NULL, revoked_at = COALESCE(revoked_at, now()) WHERE created_by = $1");
    for (const table of [
      "signups",
      "account_secrets",
      "recovery_emails",
      "recoveries",
      "keychain_moves",
      "handle_changes",
      "public_profiles",
      "messaging_policies",
      "discovery_settings",
      "phone_links",
      "invite_grants",
      "terms_acceptances",
      "signup_replays",
      "support_rooms",
      "news_deliveries",
      "news_rooms",
      "govbr_challenges",
      "business_domains",
      "account_links",
      "link_events",
      "link_nonces",
      "link_flows",
      "work_hours",
      "profile_changes",
      "profile_snapshots",
    ]) {
      await q(`DELETE FROM ${table} WHERE user_id = $1`);
    }
    // ADR 0140 point 6: only the CPF hash and the badge record stay (deletionVerificationKeepDays).
    await q("DELETE FROM business_claims WHERE user_id = $1 AND status NOT IN ('verified', 'revoked')");
    await q(
      "UPDATE business_claims SET status = 'revoked', reason = 'account_deleted', challenge = '', ended_at = COALESCE(ended_at, now()) WHERE user_id = $1",
    );
    await q("UPDATE person_verifications SET verified_name = '', device_key = '' WHERE user_id = $1");
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  await forgetBugReports(deps.db, deps.bugReportsDir, userId);
  await deps.growth?.forget(userId);
}

/** Retention: deletionVerificationKeepDays after a deletion, the marker row, the CPF hash and the badge record go. */
export async function pruneDeletions(db: Db): Promise<number> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ user_id: string }>(
      "DELETE FROM account_deletions WHERE state = 'done' AND done_at < now() - make_interval(days => $1) RETURNING user_id",
      [accountRules.deletionVerificationKeepDays],
    );
    const users = rows.map((r) => r.user_id);
    if (users.length > 0) {
      await client.query("DELETE FROM person_verifications WHERE user_id = ANY($1)", [users]);
      await client.query("DELETE FROM business_claims WHERE user_id = ANY($1) AND reason = 'account_deleted'", [users]);
    }
    await client.query("COMMIT");
    return users.length;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Staff CLI `deletion status`: counts, and the ids of requests whose last try failed. No user IDs. */
export async function deletionStatus(db: Db) {
  const { rows } = await db.query<{ state: string; n: number }>("SELECT state, count(*)::int AS n FROM account_deletions GROUP BY state");
  const failing = await db.query<{ id: string; step: string | null; tries: number; last_error: string; next_try_at: Date | null }>(
    "SELECT id, step, tries, last_error, next_try_at FROM account_deletions WHERE state = 'running' AND last_error IS NOT NULL ORDER BY due_at",
  );
  return { counts: Object.fromEntries(rows.map((r) => [r.state, r.n])), failing: failing.rows };
}

export const DELETION_TICK_MS = 60_000;
