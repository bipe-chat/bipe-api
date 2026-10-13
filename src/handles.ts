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

export async function myHandle(db: Db, userId: string) {
  const { rows } = await db.query<{ handle: string; set_at: Date }>(
    "SELECT handle, set_at FROM handles WHERE user_id = $1",
    [userId],
  );
  const row = rows[0];
  if (!row) return { user_id: userId };
  const changeableAt = new Date(row.set_at.getTime() + handleRules.changeCooldownDays * DAY_MS);
  return {
    user_id: userId,
    handle: row.handle,
    ...(changeableAt > new Date() ? { changeable_at: changeableAt.toISOString() } : {}),
  };
}

/**
 * Sets or changes a handle in one transaction. The old skeleton goes on hold.
 * `staff` (admin CLI only) skips the change cooldown. Every other check still applies.
 */
export async function setHandle(db: Db, userId: string, raw: string, { staff = false }: { staff?: boolean } = {}) {
  const { handle, skeleton } = validHandle(raw, userId);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ handle: string; skeleton: string; set_at: Date }>(
      "SELECT handle, skeleton, set_at FROM handles WHERE user_id = $1 FOR UPDATE",
      [userId],
    );
    const current = rows[0];
    if (current?.handle === handle) {
      await client.query("ROLLBACK");
      return myHandle(db, userId);
    }
    if (current && !staff) {
      const changeableAt = new Date(current.set_at.getTime() + handleRules.changeCooldownDays * DAY_MS);
      if (changeableAt > new Date()) {
        throw new ApiError("handle_cooldown", undefined, { changeable_at: changeableAt.toISOString() });
      }
    }
    if (!(await skeletonFree(client, skeleton, userId))) throw new ApiError("handle_taken");
    if (current && current.skeleton !== skeleton) {
      await client.query(
        `INSERT INTO handle_holds (skeleton, user_id, hold_until) VALUES ($1, $2, now() + make_interval(days => $3))
         ON CONFLICT (skeleton) DO UPDATE SET user_id = EXCLUDED.user_id, hold_until = EXCLUDED.hold_until`,
        [current.skeleton, userId, handleRules.releaseHoldDays],
      );
    }
    await client.query("DELETE FROM handle_holds WHERE skeleton = $1 AND user_id = $2", [skeleton, userId]);
    await client.query(
      `INSERT INTO handles (user_id, handle, skeleton) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET handle = EXCLUDED.handle, skeleton = EXCLUDED.skeleton, set_at = now()`,
      [userId, handle, skeleton],
    );
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
