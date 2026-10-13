import type pg from "pg";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { handleRules, problemWithHandle, skeletonOf } from "./registry.js";

type Queryable = Db | pg.PoolClient;

const DAY_MS = 86_400_000;

/** `claimant`: the Matrix user ID that wants the handle, "" for a new account. */
export function validHandle(raw: string, claimant: string): { handle: string; skeleton: string } {
  const handle = raw.replace(/^@/, "");
  const problem = problemWithHandle(handle, claimant);
  if (problem) throw new ApiError("handle_invalid", problem);
  return { handle, skeleton: skeletonOf(handle) };
}

/** True when no other user holds the skeleton or keeps it on hold. */
export async function skeletonFree(db: Queryable, skeleton: string, forUserId: string | null): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM handles WHERE skeleton = $1 AND user_id IS DISTINCT FROM $2
     UNION ALL
     SELECT 1 FROM handle_holds WHERE skeleton = $1 AND hold_until > now() AND user_id IS DISTINCT FROM $2`,
    [skeleton, forUserId],
  );
  return rowCount === 0;
}

export async function availability(db: Db, raw: string) {
  const handle = raw.replace(/^@/, "");
  // No auth: answer as for a new account, so an owned handle is "reserved" (ADR 0065).
  const problem = problemWithHandle(handle, "");
  if (problem) return { handle, available: false, reason: problem };
  const free = await skeletonFree(db, skeletonOf(handle), null);
  return free ? { handle, available: true } : { handle, available: false, reason: "taken" };
}

/** When the current handle was set. Without a handle: when the removed one was set (a removal keeps the cooldown). */
async function lastSetAt(db: Queryable, userId: string): Promise<{ handle?: string; skeleton?: string; setAt?: Date }> {
  const { rows } = await db.query<{ handle: string; skeleton: string; set_at: Date }>(
    "SELECT handle, skeleton, set_at FROM handles WHERE user_id = $1",
    [userId],
  );
  if (rows[0]) return { handle: rows[0].handle, skeleton: rows[0].skeleton, setAt: rows[0].set_at };
  const { rows: last } = await db.query<{ new_handle: string | null; old_set_at: Date | null }>(
    "SELECT new_handle, old_set_at FROM handle_changes WHERE user_id = $1 ORDER BY changed_at DESC, id DESC LIMIT 1",
    [userId],
  );
  return last[0] && last[0].new_handle === null && last[0].old_set_at ? { setAt: last[0].old_set_at } : {};
}

const changeableAfter = (setAt: Date | undefined) =>
  setAt ? new Date(setAt.getTime() + handleRules.changeCooldownDays * DAY_MS) : undefined;

export async function myHandle(db: Queryable, userId: string) {
  const { handle, setAt } = await lastSetAt(db, userId);
  const changeableAt = changeableAfter(setAt);
  return {
    user_id: userId,
    ...(handle ? { handle } : {}),
    ...(changeableAt && changeableAt > new Date() ? { changeable_at: changeableAt.toISOString() } : {}),
  };
}

/** One row of the change history (ADR 0066), in the caller's transaction. */
async function recordChange(
  client: pg.PoolClient,
  userId: string,
  old: { handle?: string; setAt?: Date },
  newHandle: string | null,
  staff: boolean,
) {
  await client.query(
    "INSERT INTO handle_changes (user_id, old_handle, new_handle, old_set_at, source) VALUES ($1, $2, $3, $4, $5)",
    [userId, old.handle ?? null, newHandle, old.handle ? old.setAt : null, staff ? "staff" : "user"],
  );
}

/** Puts a released skeleton on hold for its last holder. */
async function holdSkeleton(client: pg.PoolClient, skeleton: string, userId: string) {
  await client.query(
    `INSERT INTO handle_holds (skeleton, user_id, hold_until) VALUES ($1, $2, now() + make_interval(days => $3))
     ON CONFLICT (skeleton) DO UPDATE SET user_id = EXCLUDED.user_id, hold_until = EXCLUDED.hold_until`,
    [skeleton, userId, handleRules.releaseHoldDays],
  );
}

/** Serialises handle writes of one account, also when it has no handles row yet. */
const lockUser = (client: pg.PoolClient, userId: string) =>
  client.query("SELECT pg_advisory_xact_lock(7140166, hashtext($1))", [userId]);

/**
 * Sets or changes a handle in one transaction. The old skeleton goes on hold.
 * `staff` (admin CLI only) skips the change cooldown. Every other check still applies.
 * The change goes into the history in the same transaction (ADR 0066).
 */
export async function setHandle(db: Db, userId: string, raw: string, { staff = false }: { staff?: boolean } = {}) {
  const { handle, skeleton } = validHandle(raw, userId);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await lockUser(client, userId);
    const current = await lastSetAt(client, userId);
    if (current.handle === handle) {
      await client.query("ROLLBACK");
      return myHandle(db, userId);
    }
    const changeableAt = changeableAfter(current.setAt);
    if (!staff && changeableAt && changeableAt > new Date()) {
      throw new ApiError("handle_cooldown", undefined, { changeable_at: changeableAt.toISOString() });
    }
    if (!(await skeletonFree(client, skeleton, userId))) throw new ApiError("handle_taken");
    if (current.skeleton && current.skeleton !== skeleton) await holdSkeleton(client, current.skeleton, userId);
    await client.query("DELETE FROM handle_holds WHERE skeleton = $1 AND user_id = $2", [skeleton, userId]);
    await client.query(
      `INSERT INTO handles (user_id, handle, skeleton) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET handle = EXCLUDED.handle, skeleton = EXCLUDED.skeleton, set_at = now()`,
      [userId, handle, skeleton],
    );
    await recordChange(client, userId, current, handle, staff);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    if ((e as { code?: string }).code === "23505") throw new ApiError("handle_taken");
    throw e;
  } finally {
    client.release();
  }
  return myHandle(db, userId);
}

/** Removes the caller's handle (ADR 0066). The skeleton goes on hold; the cooldown keeps running from the last set. */
export async function removeHandle(db: Db, userId: string) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await lockUser(client, userId);
    const current = await lastSetAt(client, userId);
    if (current.handle && current.skeleton) {
      await holdSkeleton(client, current.skeleton, userId);
      await client.query("DELETE FROM handles WHERE user_id = $1", [userId]);
      await recordChange(client, userId, current, null, false);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return myHandle(db, userId);
}

/** Retention (ADR 0066): 365 days and the last 20 changes per account. */
export const HANDLE_CHANGE_KEEP_DAYS = 365;
const HANDLE_CHANGE_KEEP_PER_USER = 20;

/** History for the given Matrix IDs, oldest first (ADR 0066). The caller sends the IDs it shares rooms with. */
export async function handleChanges(db: Db, userIds: string[], since?: Date) {
  const { rows } = await db.query<{ user_id: string; old_handle: string | null; new_handle: string | null; changed_at: Date }>(
    `SELECT user_id, old_handle, new_handle, changed_at FROM handle_changes
     WHERE user_id = ANY($1) AND date_trunc('milliseconds', changed_at) > COALESCE($2::timestamptz, '-infinity')
       AND changed_at > now() - make_interval(days => $3)
     ORDER BY changed_at, id`,
    [userIds, since ?? null, HANDLE_CHANGE_KEEP_DAYS],
  );
  return {
    changes: rows.map((r) => ({
      user_id: r.user_id,
      ...(r.old_handle ? { old: r.old_handle } : {}),
      ...(r.new_handle ? { new: r.new_handle } : {}),
      at: r.changed_at.toISOString(),
    })),
  };
}

export async function pruneHandleChanges(db: Db): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM handle_changes WHERE changed_at <= now() - make_interval(days => $1)
        OR id IN (SELECT id FROM (
             SELECT id, row_number() OVER (PARTITION BY user_id ORDER BY changed_at DESC, id DESC) AS n FROM handle_changes
           ) ranked WHERE n > $2)`,
    [HANDLE_CHANGE_KEEP_DAYS, HANDLE_CHANGE_KEEP_PER_USER],
  );
  return rowCount ?? 0;
}

export async function lookup(db: Db, raw: string) {
  const { rows } = await db.query<{ handle: string; user_id: string }>(
    "SELECT handle, user_id FROM handles WHERE handle = $1",
    [raw.replace(/^@/, "").toLowerCase()],
  );
  if (!rows[0]) throw new ApiError("not_found");
  return rows[0];
}

export async function resolve(db: Db, userIds: string[]) {
  const { rows } = await db.query<{ handle: string; user_id: string }>(
    "SELECT handle, user_id FROM handles WHERE user_id = ANY($1)",
    [userIds],
  );
  return { handles: Object.fromEntries(rows.map((r) => [r.user_id, r.handle])) };
}
