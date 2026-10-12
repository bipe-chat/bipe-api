import { createHash, randomInt } from "node:crypto";
import type pg from "pg";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { extractInviteCode } from "./registry.js";

// Unambiguous uppercase alphabet: no 0/O, 1/I/L.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function newInviteCode(): string {
  const chars = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

// Rule: proseio-shared/registries/invite-codes.json, through the generated reference implementation.
export { extractInviteCode };

/** Hash of a code already normalised by extractInviteCode (or created by newInviteCode). */
export function inviteHash(code: string): string {
  return createHash("sha256").update(code.replace(/-/g, "")).digest("hex");
}

export async function createInvite(db: Db, uses: number, days: number, note?: string): Promise<string> {
  const code = newInviteCode();
  await db.query(
    "INSERT INTO invites (code_hash, uses_left, expires_at, note) VALUES ($1, $2, now() + make_interval(days => $3), $4)",
    [inviteHash(code), uses, days, note ?? null],
  );
  return code;
}

/** Takes one use. Returns the invite id, or null when the code is unknown, used up, expired or revoked. */
export async function takeInviteUse(db: Db, text: string): Promise<number | null> {
  const code = extractInviteCode(text);
  if (!code) return null;
  const { rows } = await db.query<{ id: string }>(
    `UPDATE invites SET uses_left = uses_left - 1
     WHERE code_hash = $1 AND uses_left > 0 AND expires_at > now() AND revoked_at IS NULL
     RETURNING id`,
    [inviteHash(code)],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

export async function returnInviteUse(db: Db, inviteId: number): Promise<void> {
  await db.query("UPDATE invites SET uses_left = uses_left + 1 WHERE id = $1", [inviteId]);
}

// Personal invites: single use, 30 days, revocable while pending (docs/growth.md "Throttle").
const PERSONAL_INVITE_DAYS = 30;

type InviteStatus = "pending" | "used" | "expired" | "revoked";

interface InviteRow {
  id: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  joined_user_id: string | null;
  joined_at: Date | null;
}

export interface InvitePolicy {
  perUser: number;
  respawnDays: number;
}

const DAY_MS = 86_400_000;

/** When an invite gives its slot back, or null when it holds none. Pending: at expiry. Used: respawnDays after the join. */
function slotReleaseAt(row: InviteRow, now: Date, respawnDays: number): Date | null {
  const status = statusOf(row, now);
  if (status === "pending") return row.expires_at;
  if (status === "used" && row.joined_at) {
    const release = new Date(row.joined_at.getTime() + respawnDays * DAY_MS);
    return release > now ? release : null;
  }
  return null;
}

function statusOf(row: InviteRow, now: Date): InviteStatus {
  if (row.joined_user_id) return "used";
  if (row.revoked_at) return "revoked";
  return row.expires_at > now ? "pending" : "expired";
}

async function quotaOf(db: Db | pg.PoolClient, userId: string, base: number): Promise<number> {
  const { rows } = await db.query<{ extra: number }>("SELECT extra FROM invite_grants WHERE user_id = $1", [userId]);
  return base + (rows[0]?.extra ?? 0);
}

// Pending invites hold a slot until they expire or are revoked. Used invites hold it for respawnDays after the join.
async function slotsTaken(db: Db | pg.PoolClient, userId: string, respawnDays: number): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM invites i
     WHERE i.created_by = $1
       AND (EXISTS (SELECT 1 FROM signups s WHERE s.invite_id = i.id AND s.created_at > now() - make_interval(days => $2))
            OR (i.revoked_at IS NULL AND i.expires_at > now()
                AND NOT EXISTS (SELECT 1 FROM signups s WHERE s.invite_id = i.id)))`,
    [userId, respawnDays],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function myInvites(db: Db, userId: string, policy: InvitePolicy) {
  const { rows } = await db.query<InviteRow>(
    `SELECT i.id, i.created_at, i.expires_at, i.revoked_at, s.user_id AS joined_user_id, s.created_at AS joined_at
     FROM invites i LEFT JOIN signups s ON s.invite_id = i.id
     WHERE i.created_by = $1 ORDER BY i.created_at DESC LIMIT 200`,
    [userId],
  );
  const quota = await quotaOf(db, userId, policy.perUser);
  const now = new Date();
  const releases = rows.map((r) => slotReleaseAt(r, now, policy.respawnDays)).filter((d): d is Date => d !== null);
  const invites = rows.map((r) => {
    const status = statusOf(r, now);
    return {
      id: String(r.id),
      status,
      created_at: r.created_at.toISOString(),
      expires_at: r.expires_at.toISOString(),
      ...(status === "used" && r.joined_user_id ? { joined_user_id: r.joined_user_id } : {}),
    };
  });
  const available = Math.max(0, quota - releases.length);
  // Only useful when nothing is available: the next moment a slot comes back.
  const next = available === 0 && releases.length > 0 ? new Date(Math.min(...releases.map((d) => d.getTime()))) : null;
  return { quota, available, ...(next ? { next_available_at: next.toISOString() } : {}), invites };
}

export async function createPersonalInvite(db: Db, userId: string, policy: InvitePolicy, siteUrl: string) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // One creation at a time per user, so two requests cannot both take the last slot.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [userId]);
    if ((await slotsTaken(client, userId, policy.respawnDays)) >= (await quotaOf(client, userId, policy.perUser))) {
      throw new ApiError("invite_quota_exhausted");
    }
    const code = newInviteCode();
    const { rows } = await client.query<{ id: string; expires_at: Date }>(
      `INSERT INTO invites (code_hash, uses_left, expires_at, created_by)
       VALUES ($1, 1, now() + make_interval(days => $2), $3) RETURNING id, expires_at`,
      [inviteHash(code), PERSONAL_INVITE_DAYS, userId],
    );
    await client.query("COMMIT");
    const row = rows[0]!;
    return {
      id: String(row.id),
      code,
      url: `${siteUrl.replace(/\/$/, "")}/convite/${code}`,
      expires_at: row.expires_at.toISOString(),
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Revokes a pending invite of the caller. Used, expired and foreign invites are not_found. */
export async function revokePersonalInvite(db: Db, userId: string, inviteId: string): Promise<void> {
  if (!/^[0-9]{1,18}$/.test(inviteId)) throw new ApiError("not_found");
  const { rowCount } = await db.query(
    `UPDATE invites i SET revoked_at = now()
     WHERE i.id = $1 AND i.created_by = $2 AND i.revoked_at IS NULL AND i.expires_at > now()
       AND NOT EXISTS (SELECT 1 FROM signups s WHERE s.invite_id = i.id)`,
    [inviteId, userId],
  );
  if (rowCount !== 1) throw new ApiError("not_found");
}

/** Validity and, for a personal invite, the inviter's handle. Never says why a code is invalid. */
export async function previewInvite(db: Db, text: string) {
  const code = extractInviteCode(text);
  if (!code) return { valid: false };
  const { rows } = await db.query<{ handle: string | null }>(
    `SELECT h.handle FROM invites i LEFT JOIN handles h ON h.user_id = i.created_by
     WHERE i.code_hash = $1 AND i.uses_left > 0 AND i.expires_at > now() AND i.revoked_at IS NULL`,
    [inviteHash(code)],
  );
  if (!rows[0]) return { valid: false };
  return rows[0].handle ? { valid: true, inviter_handle: rows[0].handle } : { valid: true };
}

/** The user who created an invite, or null for admin invites. */
export async function inviterOf(db: Db, inviteId: number): Promise<string | null> {
  const { rows } = await db.query<{ created_by: string | null }>("SELECT created_by FROM invites WHERE id = $1", [inviteId]);
  return rows[0]?.created_by ?? null;
}

export async function grantInvites(db: Db, userId: string, extra: number): Promise<void> {
  await db.query(
    `INSERT INTO invite_grants (user_id, extra) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET extra = invite_grants.extra + EXCLUDED.extra`,
    [userId, extra],
  );
}

/** Revokes every pending invite a user created. For abuse handling. */
export async function revokeAllOf(db: Db, userId: string): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE invites i SET revoked_at = now()
     WHERE i.created_by = $1 AND i.revoked_at IS NULL AND i.expires_at > now()
       AND NOT EXISTS (SELECT 1 FROM signups s WHERE s.invite_id = i.id)`,
    [userId],
  );
  return rowCount ?? 0;
}

/** The caller's invite pairs (ADR 0034): people the caller invited who joined, and the caller's own inviter. */
export async function inviteConnections(db: Db, userId: string) {
  const { rows } = await db.query<{ user_id: string }>(
    `SELECT s.user_id FROM invites i JOIN signups s ON s.invite_id = i.id WHERE i.created_by = $1
     UNION
     SELECT i.created_by AS user_id FROM signups s JOIN invites i ON i.id = s.invite_id
     WHERE s.user_id = $1 AND i.created_by IS NOT NULL
     LIMIT 1000`,
    [userId],
  );
  return { user_ids: rows.map((r) => r.user_id).filter((id) => id !== userId) };
}
