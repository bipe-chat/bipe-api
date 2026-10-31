// First-contact outcomes (security.md rule 11, bipe-chat/bipe#39, bipe-chat/bipe#845; windows in
// bipe-shared registries/reach.json). A first contact is an invite that mayInvite allows when the two users share
// no other joined room and no invite pair. One first_contacts row per first contact keeps the inviter, a keyed hash
// of the invitee, the room and the time, for recipientDays. The Synapse module bipe_messaging reports the invitee's
// join (accepted), the invitee's own leave from the invite (declined) and a new ignore of the inviter (blocked,
// within blockWindowDays). A row with no outcome and no block when it goes counts as ignored. A user report
// (Synapse event_reports) counts against the sender of the reported event. reach_daily keeps the per-sender counts
// per day in Brazil for dailyCountDays. Never a recipient ID in clear, never content. Logs carry counts only, never
// a user ID next to an outcome.
import { createHmac, hkdfSync } from "node:crypto";
import pg from "pg";
import type { Db } from "./db.js";
import { reachRules } from "./registry.js";

const TZ = "America/Sao_Paulo";
const REPORT_BATCH = 1000;
/** Per-inviter advisory lock: first contacts of one inviter are taken one at a time. */
export const REACH_LOCK = 7140845;
export const COUNTS = ["sent", "accepted", "declined", "ignored", "blocked", "reported"] as const;
export type Count = (typeof COUNTS)[number];

type Queryable = Pick<pg.PoolClient, "query">;

/**
 * The invitee key: HKDF-SHA256 of BIPE_GROWTH_HMAC_SECRET with its own info, so the invitee hash never equals the
 * growth pseudonym of the same account. Never rotate the growth secret (bipe-api AGENTS.md).
 */
export function inviteeKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), "bipe reach invitee v1", 32));
}

export function inviteeHash(key: Buffer, userId: string): string {
  return createHmac("sha256", key).update(userId, "utf8").digest("hex");
}

/** Adds n to one count of one sender on the Brazilian day of `at`. */
async function bump(q: Queryable, userId: string, at: Date | string, count: Count, n = 1): Promise<void> {
  if (!COUNTS.includes(count)) throw new Error("reach: unknown count");
  await q.query(
    `INSERT INTO reach_daily (user_id, day, ${count}) VALUES ($1, ($2::timestamptz AT TIME ZONE '${TZ}')::date, $3)
     ON CONFLICT (user_id, day) DO UPDATE SET ${count} = reach_daily.${count} + EXCLUDED.${count}`,
    [userId, at, n],
  );
}

export type DailyCounts = { day: string } & Record<Count, number>;

export class Reach {
  private readonly key: Buffer | null;
  private readonly synapse: pg.Pool | null;
  private readonly serverSuffix: string;
  private syncing = false;

  constructor(
    private readonly db: Db,
    opts: { secret?: string; synapseUrl?: string; serverName: string },
  ) {
    this.key = opts.secret ? inviteeKey(opts.secret) : null;
    this.synapse = opts.synapseUrl ? new pg.Pool({ connectionString: opts.synapseUrl, max: 1 }) : null;
    this.serverSuffix = `:${opts.serverName}`;
  }

  /** Off without BIPE_GROWTH_HMAC_SECRET: nothing is recorded, the module calls do nothing. */
  get enabled(): boolean {
    return this.key !== null;
  }

  /** For the start log only. */
  get state(): string {
    if (!this.key) return "off (no BIPE_GROWTH_HMAC_SECRET)";
    return this.synapse ? "on" : "on, without reports (no SYNAPSE_DATABASE_URL)";
  }

  hash(userId: string): string | null {
    return this.key ? inviteeHash(this.key, userId) : null;
  }

  /** Records a first contact that mayInvite allowed. */
  async record(inviter: string, invitee: string, roomId: string | null, now = new Date()): Promise<void> {
    await this.tx((q) => this.insert(q, inviter, invitee, roomId, now));
  }

  /** The record of one first contact, inside the caller's transaction. */
  async insert(q: Queryable, inviter: string, invitee: string, roomId: string | null, now = new Date()): Promise<void> {
    const hash = this.hash(invitee);
    if (!hash) return;
    await q.query("INSERT INTO first_contacts (inviter, invitee_hash, room_id, sent_at) VALUES ($1, $2, $3, $4)", [inviter, hash, roomId, now]);
    await bump(q, inviter, now, "sent");
  }

  /** First contacts of one inviter in the last `hours`. The caller holds REACH_LOCK for the inviter. */
  async sentWithin(q: Queryable, inviter: string, hours: number, now = new Date()) {
    const { rows } = await q.query<{ n: number; oldest: Date | null }>(
      `SELECT count(*)::int AS n, min(sent_at) AS oldest FROM first_contacts
        WHERE inviter = $1 AND sent_at > $2::timestamptz - make_interval(hours => $3)`,
      [inviter, now, hours],
    );
    return rows[0]!;
  }

  /**
   * The invitee joined (accepted) or left by itself (declined) a room of a first contact. A first outcome sticks:
   * a later leave after a join changes nothing. Returns the number of first contacts it settled.
   */
  async membership(roomId: string, userId: string, membership: "join" | "leave"): Promise<number> {
    const hash = this.hash(userId);
    if (!hash) return 0;
    const outcome = membership === "join" ? "accepted" : "declined";
    return this.tx(async (q) => {
      const { rows } = await q.query<{ inviter: string; sent_at: Date }>(
        `UPDATE first_contacts SET outcome = $3, outcome_at = now()
          WHERE room_id = $1 AND invitee_hash = $2 AND outcome IS NULL RETURNING inviter, sent_at`,
        [roomId, hash, outcome],
      );
      for (const r of rows) await bump(q, r.inviter, r.sent_at, outcome);
      return rows.length;
    });
  }

  /**
   * The user's ignore list (m.ignored_user_list) changed. An ignored inviter of a first contact to this user in the
   * last blockWindowDays counts as blocked, once per inviter. Returns the number of inviters that got a block.
   */
  async ignored(userId: string, ignoredUsers: string[]): Promise<number> {
    const hash = this.hash(userId);
    if (!hash || ignoredUsers.length === 0) return 0;
    return this.tx(async (q) => {
      const { rows } = await q.query<{ inviter: string; sent_at: Date }>(
        `WITH hit AS (
           UPDATE first_contacts SET blocked_at = now()
            WHERE invitee_hash = $1 AND inviter = ANY($2::text[]) AND blocked_at IS NULL
              AND sent_at > now() - make_interval(days => $3)
              AND NOT EXISTS (SELECT 1 FROM first_contacts b WHERE b.invitee_hash = $1 AND b.inviter = first_contacts.inviter AND b.blocked_at IS NOT NULL)
           RETURNING inviter, sent_at)
         SELECT inviter, min(sent_at) AS sent_at FROM hit GROUP BY inviter`,
        [hash, ignoredUsers, reachRules.blockWindowDays],
      );
      for (const r of rows) await bump(q, r.inviter, r.sent_at, "blocked");
      return rows.length;
    });
  }

  /**
   * New Synapse user reports since the last run, each counted against the local sender of the reported event on the
   * day of the report. Reads event_reports (id, received_ts, event_id) and events (event_id, sender) through the
   * role bipe_growth (bipe-infra scripts/setup-growth.sh). Returns the number of reports read, or null when off.
   */
  async syncReports(): Promise<number | null> {
    if (!this.synapse || this.syncing) return null;
    this.syncing = true;
    try {
      let total = 0;
      for (;;) {
        const { rows: state } = await this.db.query<{ reports_cursor: string }>("SELECT reports_cursor FROM reach_state WHERE id = 1");
        const cursor = state[0]?.reports_cursor ?? "0";
        const { rows } = await this.synapse.query<{ id: string; received_ts: string; sender: string | null }>(
          `SELECT r.id, r.received_ts, e.sender FROM event_reports r LEFT JOIN events e ON e.event_id = r.event_id
            WHERE r.id > $1::bigint AND r.received_ts > (extract(epoch FROM now()) * 1000)::bigint - $2::bigint * 86400000
            ORDER BY r.id LIMIT ${REPORT_BATCH}`,
          [cursor, reachRules.dailyCountDays],
        );
        if (rows.length === 0) return total;
        await this.tx(async (q) => {
          for (const r of rows) {
            if (r.sender?.endsWith(this.serverSuffix)) await bump(q, r.sender, new Date(Number(r.received_ts)), "reported");
          }
          await q.query(
            `INSERT INTO reach_state (id, reports_cursor) VALUES (1, $1)
             ON CONFLICT (id) DO UPDATE SET reports_cursor = EXCLUDED.reports_cursor`,
            [rows.at(-1)!.id],
          );
        });
        total += rows.length;
        if (rows.length < REPORT_BATCH) return total;
      }
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Retention: a first contact goes recipientDays after it was sent; one with no outcome and no block counts as
   * ignored first. Daily counts go after dailyCountDays. Returns the rows deleted.
   */
  async prune(): Promise<{ firstContacts: number; days: number }> {
    return this.tx(async (q) => {
      const { rows } = await q.query<{ n: number }>(
        `WITH gone AS (
           DELETE FROM first_contacts WHERE sent_at <= now() - make_interval(days => $1)
           RETURNING inviter, sent_at, outcome, blocked_at),
         ignored AS (
           INSERT INTO reach_daily (user_id, day, ignored)
           SELECT inviter, (sent_at AT TIME ZONE '${TZ}')::date, count(*)::int FROM gone
            WHERE outcome IS NULL AND blocked_at IS NULL GROUP BY 1, 2
           ON CONFLICT (user_id, day) DO UPDATE SET ignored = reach_daily.ignored + EXCLUDED.ignored)
         SELECT count(*)::int AS n FROM gone`,
        [reachRules.recipientDays],
      );
      const days = await q.query("DELETE FROM reach_daily WHERE day < (now() AT TIME ZONE $2)::date - $1::int", [reachRules.dailyCountDays, TZ]);
      return { firstContacts: rows[0]!.n, days: days.rowCount ?? 0 };
    });
  }

  /** Staff CLI `reach show`: one sender's counts per day, newest first. */
  async daily(userId: string, days: number): Promise<DailyCounts[]> {
    const { rows } = await this.db.query<DailyCounts>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, ${COUNTS.join(", ")} FROM reach_daily
        WHERE user_id = $1 AND day > (now() AT TIME ZONE '${TZ}')::date - $2::int ORDER BY day DESC`,
      [userId, days],
    );
    return rows;
  }

  async close(): Promise<void> {
    await this.synapse?.end();
  }

  private async tx<T>(f: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const out = await f(client);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
}
