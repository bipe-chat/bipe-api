import { createHash, randomBytes } from "node:crypto";
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

/**
 * A staff CLI argument as a Matrix user ID: a full ID on this server, or an @handle. Refuses an ID with no live MAS
 * account, so a handle typed as a full ID never writes rows for an account that does not exist.
 */
export async function existingAccount(
  db: Db,
  mas: { userState(username: string): Promise<{ deactivated: boolean } | null> },
  serverName: string,
  raw: string,
): Promise<string> {
  const arg = raw.trim();
  let userId: string;
  if (arg.includes(":")) {
    if (!/^@[^:]+:.+$/.test(arg)) throw new Error(`${arg} is not a Matrix user ID`);
    if (!arg.endsWith(`:${serverName}`)) throw new Error(`${arg} is not a user on ${serverName}`);
    userId = arg;
  } else {
    try {
      userId = (await lookup(db, arg)).user_id;
    } catch (e) {
      if (e instanceof ApiError && e.id === "not_found") throw new Error(`no account has the handle ${arg}`);
      throw e;
    }
  }
  const state = await mas.userState(userId.slice(1, userId.indexOf(":")));
  if (!state) throw new Error(`${userId} has no account`);
  if (state.deactivated) throw new Error(`${userId} is deactivated`);
  return userId;
}

// ADR 0287: a handle moves from a personal account to a work account of the same person.
const MOVE_CODE_MS = 10 * 60_000;
const hashMoveCode = (code: string) => createHash("sha256").update(code).digest("hex");

async function isWorkAccount(q: Queryable, userId: string) {
  const { rows } = await q.query<{ account_type: string }>("SELECT account_type FROM signups WHERE user_id = $1", [userId]);
  return rows[0]?.account_type === "company";
}

/** POST /v1/me/handle/move: a one-time code for the work account to claim. Only its hash is kept. */
export async function startHandleMove(db: Db, userId: string) {
  if (await isWorkAccount(db, userId)) throw new ApiError("bad_request", "not_personal");
  const { rowCount } = await db.query("SELECT 1 FROM handles WHERE user_id = $1", [userId]);
  if (!rowCount) throw new ApiError("bad_request", "no_handle");
  const code = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + MOVE_CODE_MS);
  await db.query("DELETE FROM handle_moves WHERE expires_at < now()");
  await db.query(
    `INSERT INTO handle_moves (from_user, code_hash, expires_at) VALUES ($1, $2, $3)
     ON CONFLICT (from_user) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at`,
    [userId, hashMoveCode(code), expiresAt],
  );
  return { code, expires_at: expiresAt.toISOString() };
}

/** Moves the handle, its history rows and the public feed, in the caller's transaction (ADR 0287 point 14). */
async function moveHandleTx(client: pg.PoolClient, from: string, to: string, staff: boolean) {
  // Both accounts in a fixed order, so two moves cannot deadlock.
  for (const id of [from, to].sort()) await lockUser(client, id);
  const { rows } = await client.query<{ handle: string; skeleton: string; set_at: Date }>(
    "SELECT handle, skeleton, set_at FROM handles WHERE user_id = $1",
    [from],
  );
  const source = rows[0];
  if (!source) throw new ApiError("handle_taken");
  const target = await client.query("SELECT 1 FROM handles WHERE user_id = $1 UNION ALL SELECT 1 FROM public_feeds WHERE user_id = $1", [to]);
  if (target.rowCount) throw new ApiError("bad_request", "has_handle");
  await client.query("DELETE FROM handles WHERE user_id = $1", [from]);
  await client.query("DELETE FROM handle_holds WHERE skeleton = $1", [source.skeleton]);
  await client.query("INSERT INTO handles (user_id, handle, skeleton) VALUES ($1, $2, $3)", [to, source.handle, source.skeleton]);
  await recordChange(client, from, { handle: source.handle, setAt: source.set_at }, null, staff);
  await recordChange(client, to, {}, source.handle, staff);
  await client.query("UPDATE public_feeds SET user_id = $2, updated_at = now() WHERE user_id = $1", [from, to]);
  await client.query("UPDATE public_feed_posts SET user_id = $2 WHERE user_id = $1", [from, to]);
  await client.query("DELETE FROM handle_moves WHERE from_user = $1", [from]);
  return source.handle;
}

async function inTransaction<T>(db: Db, run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    if ((e as { code?: string }).code === "23505") throw new ApiError("handle_taken");
    throw e;
  } finally {
    client.release();
  }
}

/** POST /v1/me/handle/move/claim: the work account takes the handle (ADR 0287 points 12 to 15). */
export async function claimHandleMove(db: Db, userId: string, code: string) {
  if (!(await isWorkAccount(db, userId))) throw new ApiError("bad_request", "not_work_account");
  await inTransaction(db, async (client) => {
    const { rows } = await client.query<{ from_user: string }>(
      "SELECT from_user FROM handle_moves WHERE code_hash = $1 AND expires_at > now() FOR UPDATE",
      [hashMoveCode(code)],
    );
    const from = rows[0]?.from_user;
    if (!from) throw new ApiError("not_found");
    const samePhone = await client.query(
      `SELECT 1 FROM account_phones a JOIN account_phones b ON a.phone_id = b.phone_id
        WHERE a.user_id = $1 AND b.user_id = $2 LIMIT 1`,
      [from, userId],
    );
    if (!samePhone.rowCount) throw new ApiError("bad_request", "not_same_phone");
    await moveHandleTx(client, from, userId, false);
  });
  return myHandle(db, userId);
}

/** Staff CLI `handle move` (ADR 0287 point 17): any two accounts, no code and no phone check. */
export async function staffMoveHandle(db: Db, from: string, to: string) {
  if (from === to) throw new ApiError("bad_request", "same_account");
  return inTransaction(db, (client) => moveHandleTx(client, from, to, true));
}
