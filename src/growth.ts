import { createHmac } from "node:crypto";
import pg from "pg";
import type { Db } from "./db.js";
import { growthRules } from "./registry.js";

// Server-side growth events (ADR 0098, bipe#67). The apps send no telemetry. The event list is
// bipe-shared registries/growth-events.json. One row per pseudonymous user, event and day, with a count:
// the user is HMAC-SHA256(BIPE_GROWTH_HMAC_SECRET, Matrix ID). No content, no Matrix ID, no room ID, no IP.
// The platform events (ADR 0124) keep ios, android or web only: the user agent string is dropped after platformOf().
// Synapse-side events come from the Synapse database through the read-only role bipe_growth. That role has
// SELECT only on the columns these queries name (bipe-infra scripts/setup-growth-role.sh). Change both together.

const TZ = "America/Sao_Paulo";
const BATCH = 5000;
const MESSAGE_TYPES = ["m.room.message", "m.room.encrypted"];
const CALL_TYPES = ["m.call.invite", "m.call.member", "org.matrix.msc3401.call.member"];
// A call event counts as a start when the room had no call event in this window before it.
const CALL_GAP_MS = 3_600_000;
const LOCK = 7140198;

/** The platform of a Synapse device user agent, or null. Rule: bipe-shared registries/growth-events.json, platform_ios. */
export function platformOf(ua: string | null): "ios" | "android" | "web" | null {
  if (!ua) return null;
  if (ua.includes("Mozilla/")) return "web";
  if (/\b(iOS|iPhone|iPad|macOS)\b/.test(ua)) return "ios";
  if (/\bAndroid\b/.test(ua)) return "android";
  return null;
}

const events = new Map(growthRules.events.map((e) => [e.id, e]));

/** The calendar day in Brazil (YYYY-MM-DD) of a Unix time in milliseconds. */
export function dayOf(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

type Queryable = Pick<pg.PoolClient, "query">;

export class Growth {
  private readonly secret: string | undefined;
  private readonly synapse: pg.Pool | null;
  private running = false;

  constructor(
    private readonly db: Db,
    opts: { secret?: string; synapseUrl?: string; serverName: string; skipUsers?: string[] },
  ) {
    this.secret = opts.secret;
    this.synapse = opts.secret && opts.synapseUrl ? new pg.Pool({ connectionString: opts.synapseUrl, max: 2 }) : null;
    this.serverSuffix = `:${opts.serverName}`;
    this.skipUsers = new Set(opts.skipUsers ?? []);
  }

  private readonly serverSuffix: string;
  private readonly skipUsers: Set<string>;

  get enabled(): boolean {
    return this.secret !== undefined;
  }

  get synapseEnabled(): boolean {
    return this.synapse !== null;
  }

  private uid(userId: string): string {
    return createHmac("sha256", this.secret!).update(userId, "utf8").digest("hex");
  }

  /** The caller's own rows, for the data export (ADR 0112). Empty when growth events are off. */
  async rowsOf(userId: string): Promise<{ event: string; day: string; n: number }[]> {
    if (!this.secret) return [];
    const { rows } = await this.db.query<{ event: string; day: string; n: number }>(
      "SELECT event, to_char(day, 'YYYY-MM-DD') AS day, n FROM growth_events WHERE uid = $1 ORDER BY day, event",
      [this.uid(userId)],
    );
    return rows;
  }

  /** Account deletion (ADR 0140): every row of one account, the per-user sync positions included. */
  async forget(userId: string): Promise<void> {
    if (!this.secret) return;
    const uid = this.uid(userId);
    await this.db.query("DELETE FROM growth_events WHERE uid = $1", [uid]);
    await this.db.query("DELETE FROM growth_sync WHERE source = $1", [`contact_verified:${uid}`]);
  }

  /** Adds n to (user, event, day). For a `once` event, only the first day counts. */
  private async put(q: Queryable, uid: string, event: string, day: string, n = 1): Promise<void> {
    const rule = events.get(event);
    if (!rule) throw new Error(`growth: unknown event ${event}`);
    if (rule.once) {
      await q.query(
        `INSERT INTO growth_events (uid, event, day, n) SELECT $1, $2, $3::date, 1
          WHERE NOT EXISTS (SELECT 1 FROM growth_events WHERE uid = $1 AND event = $2)
         ON CONFLICT DO NOTHING`,
        [uid, event, day],
      );
    } else {
      await q.query(
        `INSERT INTO growth_events (uid, event, day, n) VALUES ($1, $2, $3::date, $4)
         ON CONFLICT (uid, event, day) DO UPDATE SET n = growth_events.n + EXCLUDED.n`,
        [uid, event, day, n],
      );
    }
  }

  /** An API-side event. Never throws and never logs the user: growth must not break a request. */
  record(userId: string, event: "signup_done" | "invite_sent" | "invite_redeemed"): void {
    if (!this.enabled) return;
    this.put(this.db, this.uid(userId), event, dayOf(Date.now())).catch((e) =>
      console.error(`growth: ${event} not recorded: ${(e as Error).message}`),
    );
  }

  /** onboarding_finished: the first signed-in account read after a recorded sign-up. */
  onboarded(userId: string): void {
    if (!this.enabled) return;
    const uid = this.uid(userId);
    this.db
      .query(
        `INSERT INTO growth_events (uid, event, day, n) SELECT $1, 'onboarding_finished', $2::date, 1
          WHERE EXISTS (SELECT 1 FROM growth_events WHERE uid = $1 AND event = 'signup_done')
            AND NOT EXISTS (SELECT 1 FROM growth_events WHERE uid = $1 AND event = 'onboarding_finished')
         ON CONFLICT DO NOTHING`,
        [uid, dayOf(Date.now())],
      )
      .catch((e) => console.error(`growth: onboarding_finished not recorded: ${(e as Error).message}`));
  }

  /**
   * One pass: the one-time back-fill of API events, the Synapse events since the last pass, and the prune.
   * Skips when another pass holds the lock. Returns false when it skipped.
   */
  async sync(): Promise<boolean> {
    if (!this.enabled || this.running) return false;
    this.running = true;
    const lock = await this.db.connect();
    try {
      const { rows } = await lock.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [LOCK]);
      if (!rows[0]?.ok) return false;
      try {
        await this.backfillApi();
        if (this.synapse) {
          const users = await this.localUsers();
          await this.syncEvents(users);
          await this.syncReceipts(users);
          await this.syncVerifications(users);
          await this.syncGroups(users);
          await this.syncPlatforms(users);
          await this.syncFifthContacts(users);
        }
        await this.db.query("DELETE FROM growth_events WHERE day < current_date - $1::int", [growthRules.retentionDaysKept]);
      } finally {
        await lock.query("SELECT pg_advisory_unlock($1)", [LOCK]);
      }
      return true;
    } finally {
      lock.release();
      this.running = false;
    }
  }

  private async position(q: Queryable, source: string): Promise<number> {
    const { rows } = await q.query<{ position: string }>("SELECT position FROM growth_sync WHERE source = $1", [source]);
    return rows[0] ? Number(rows[0].position) : 0;
  }

  private async setPosition(q: Queryable, source: string, position: number): Promise<void> {
    await q.query(
      `INSERT INTO growth_sync (source, position) VALUES ($1, $2)
       ON CONFLICT (source) DO UPDATE SET position = EXCLUDED.position`,
      [source, position],
    );
  }

  private async tx(fn: (q: pg.PoolClient) => Promise<void>): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await fn(client);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /** API events from before this table existed, once. Not back-filled: onboarding_finished (no record of it). */
  private async backfillApi(): Promise<void> {
    if ((await this.position(this.db, "backfill_api")) > 0) return;
    const day = (col: string) => `to_char(${col} AT TIME ZONE '${TZ}', 'YYYY-MM-DD')`;
    const signups = await this.db.query<{ user_id: string; day: string }>(`SELECT user_id, ${day("created_at")} AS day FROM signups`);
    const sent = await this.db.query<{ user_id: string; day: string; n: number }>(
      `SELECT created_by AS user_id, ${day("created_at")} AS day, count(*)::int AS n FROM invites
        WHERE created_by IS NOT NULL GROUP BY 1, 2`,
    );
    const redeemed = await this.db.query<{ user_id: string; day: string; n: number }>(
      `SELECT i.created_by AS user_id, ${day("s.created_at")} AS day, count(*)::int AS n
         FROM signups s JOIN invites i ON i.id = s.invite_id WHERE i.created_by IS NOT NULL GROUP BY 1, 2`,
    );
    await this.tx(async (q) => {
      for (const r of signups.rows) await this.put(q, this.uid(r.user_id), "signup_done", r.day);
      for (const r of sent.rows) await this.put(q, this.uid(r.user_id), "invite_sent", r.day, r.n);
      for (const r of redeemed.rows) await this.put(q, this.uid(r.user_id), "invite_redeemed", r.day, r.n);
      await this.setPosition(q, "backfill_api", 1);
    });
    console.log(`growth: back-filled ${signups.rowCount} sign-ups, ${sent.rowCount} invite days, ${redeemed.rowCount} redeem days`);
  }

  /** Local people: no application services, guests, bots or support accounts (SUPPORT_USER_ID is skipped by name). */
  private async localUsers(): Promise<Set<string>> {
    const { rows } = await this.synapse!.query<{ name: string }>(
      "SELECT name FROM users WHERE appservice_id IS NULL AND is_guest = 0 AND user_type IS NULL",
    );
    return new Set(rows.map((r) => r.name).filter((n) => n.endsWith(this.serverSuffix) && !this.skipUsers.has(n)));
  }

  /** active_day, first_message_sent and call_started from new events, in stream order. */
  private async syncEvents(users: Set<string>): Promise<void> {
    for (;;) {
      const from = await this.position(this.db, "synapse_events");
      const { rows } = await this.synapse!.query<{ so: string; sender: string; type: string; ts: string }>(
        `SELECT stream_ordering AS so, sender, type, origin_server_ts AS ts FROM events
          WHERE stream_ordering > $1 AND NOT outlier ORDER BY stream_ordering LIMIT $2`,
        [from, BATCH],
      );
      if (rows.length === 0) return;
      const to = Number(rows[rows.length - 1]!.so);
      const starts = await this.synapse!.query<{ sender: string; ts: string }>(
        `SELECT e.sender, e.origin_server_ts AS ts FROM events e
          WHERE e.stream_ordering > $1 AND e.stream_ordering <= $2 AND NOT e.outlier AND e.type = ANY($3)
            AND NOT EXISTS (SELECT 1 FROM events p WHERE p.room_id = e.room_id AND p.type = ANY($3)
                              AND p.stream_ordering < e.stream_ordering AND p.origin_server_ts > e.origin_server_ts - $4)`,
        [from, to, CALL_TYPES, CALL_GAP_MS],
      );
      const active = new Map<string, number>();
      const firstMessage = new Map<string, string>();
      for (const r of rows) {
        if (!users.has(r.sender)) continue;
        const day = dayOf(Number(r.ts));
        const key = `${r.sender}\n${day}`;
        active.set(key, (active.get(key) ?? 0) + 1);
        if (MESSAGE_TYPES.includes(r.type)) {
          const known = firstMessage.get(r.sender);
          if (!known || day < known) firstMessage.set(r.sender, day);
        }
      }
      const calls = new Map<string, number>();
      for (const r of starts.rows) {
        if (!users.has(r.sender)) continue;
        const key = `${r.sender}\n${dayOf(Number(r.ts))}`;
        calls.set(key, (calls.get(key) ?? 0) + 1);
      }
      await this.tx(async (q) => {
        for (const [key, n] of active) {
          const [user, day] = key.split("\n") as [string, string];
          await this.put(q, this.uid(user), "active_day", day, n);
        }
        for (const [user, day] of firstMessage) await this.put(q, this.uid(user), "first_message_sent", day);
        for (const [key, n] of calls) {
          const [user, day] = key.split("\n") as [string, string];
          await this.put(q, this.uid(user), "call_started", day, n);
        }
        await this.setPosition(q, "synapse_events", to);
      });
      if (rows.length < BATCH) return;
    }
  }

  /** active_day from read receipts (public and private). Synapse keeps no receipt time we read: the day is today. */
  private async syncReceipts(users: Set<string>): Promise<void> {
    for (;;) {
      const from = await this.position(this.db, "synapse_receipts");
      const { rows } = await this.synapse!.query<{ id: string; user_id: string }>(
        "SELECT stream_id AS id, user_id FROM receipts_linearized WHERE stream_id > $1 ORDER BY stream_id LIMIT $2",
        [from, BATCH],
      );
      if (rows.length === 0) return;
      const counts = new Map<string, number>();
      for (const r of rows) if (users.has(r.user_id)) counts.set(r.user_id, (counts.get(r.user_id) ?? 0) + 1);
      const today = dayOf(Date.now());
      await this.tx(async (q) => {
        for (const [user, n] of counts) await this.put(q, this.uid(user), "active_day", today, n);
        await this.setPosition(q, "synapse_receipts", Number(rows[rows.length - 1]!.id));
      });
      if (rows.length < BATCH) return;
    }
  }

  /** contact_verified: growth in the number of other users each user signed. Kept per user in growth_sync. */
  private async syncVerifications(users: Set<string>): Promise<void> {
    const { rows } = await this.synapse!.query<{ user_id: string; n: number }>(
      `SELECT user_id, count(DISTINCT target_user_id)::int AS n FROM e2e_cross_signing_signatures
        WHERE user_id <> target_user_id GROUP BY 1`,
    );
    const today = dayOf(Date.now());
    await this.tx(async (q) => {
      for (const r of rows) {
        if (!users.has(r.user_id)) continue;
        const uid = this.uid(r.user_id);
        const seen = await this.position(q, `contact_verified:${uid}`);
        if (r.n <= seen) continue;
        await this.put(q, uid, "contact_verified", today, r.n - seen);
        await this.setPosition(q, `contact_verified:${uid}`, r.n);
      }
    });
  }

  /** group_created: rooms inside the kept period, counted again each pass. A count never goes down. */
  private async syncGroups(users: Set<string>): Promise<void> {
    const since = Date.now() - growthRules.retentionDaysKept * 86_400_000;
    const { rows } = await this.synapse!.query<{ sender: string; ts: string }>(
      `SELECT c.sender, c.origin_server_ts AS ts FROM events c
         JOIN room_stats_current r ON r.room_id = c.room_id
         LEFT JOIN room_stats_state s ON s.room_id = c.room_id
        WHERE c.type = 'm.room.create' AND c.origin_server_ts > $1 AND s.room_type IS NULL
          AND (r.joined_members + r.invited_members >= 3
               OR (r.joined_members + r.invited_members >= 2
                   AND EXISTS (SELECT 1 FROM current_state_events n WHERE n.room_id = c.room_id AND n.type = 'm.room.name')))`,
      [since],
    );
    const counts = new Map<string, number>();
    for (const r of rows) {
      if (!users.has(r.sender)) continue;
      const key = `${r.sender}\n${dayOf(Number(r.ts))}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    await this.tx(async (q) => {
      for (const [key, n] of counts) {
        const [user, day] = key.split("\n") as [string, string];
        await q.query(
          `INSERT INTO growth_events (uid, event, day, n) VALUES ($1, 'group_created', $2::date, $3)
           ON CONFLICT (uid, event, day) DO UPDATE SET n = GREATEST(growth_events.n, EXCLUDED.n)`,
          [this.uid(user), day, n],
        );
      }
    });
  }

  /** platform_*: one row per user, platform and day a device was last seen. Only the platform is kept. */
  private async syncPlatforms(users: Set<string>): Promise<void> {
    const from = await this.position(this.db, "synapse_devices");
    const { rows } = await this.synapse!.query<{ user_id: string; ua: string | null; ts: string }>(
      "SELECT user_id, user_agent AS ua, last_seen AS ts FROM devices WHERE last_seen > $1",
      [from],
    );
    if (rows.length === 0) return;
    let to = from;
    const seen = new Set<string>();
    for (const r of rows) {
      to = Math.max(to, Number(r.ts));
      const platform = platformOf(r.ua);
      if (platform && users.has(r.user_id)) seen.add(`${r.user_id}\n${platform}\n${dayOf(Number(r.ts))}`);
    }
    await this.tx(async (q) => {
      for (const key of seen) {
        const [user, platform, day] = key.split("\n") as [string, string, string];
        await q.query(
          "INSERT INTO growth_events (uid, event, day, n) VALUES ($1, $2, $3::date, 1) ON CONFLICT DO NOTHING",
          [this.uid(user), `platform_${platform}`, day],
        );
      }
      await this.setPosition(q, "synapse_devices", to);
    });
  }

  /**
   * contact_fifth (bipe-chat/bipe#752): the day each user got a fifth contact. A contact is another local person who
   * shares a DM: a room that is not a space, has no room name, 2 joined members, no invited member, and m.room.member
   * events from exactly those 2 people. The day of a contact is the day of the first member event of the person who
   * came second. Recomputed each pass over the rooms made in the kept period; only the day of the fifth is stored.
   */
  private async syncFifthContacts(users: Set<string>): Promise<void> {
    const since = Date.now() - growthRules.retentionDaysKept * 86_400_000;
    const { rows } = await this.synapse!.query<{ room_id: string; sender: string; ts: string }>(
      `SELECT m.room_id, m.sender, min(m.origin_server_ts) AS ts FROM events c
         JOIN room_stats_current r ON r.room_id = c.room_id
         LEFT JOIN room_stats_state s ON s.room_id = c.room_id
         JOIN events m ON m.room_id = c.room_id AND m.type = 'm.room.member' AND NOT m.outlier
        WHERE c.type = 'm.room.create' AND c.origin_server_ts > $1 AND s.room_type IS NULL
          AND r.joined_members = 2 AND r.invited_members = 0
          AND NOT EXISTS (SELECT 1 FROM current_state_events n WHERE n.room_id = c.room_id AND n.type = 'm.room.name')
        GROUP BY m.room_id, m.sender`,
      [since],
    );
    const rooms = new Map<string, { sender: string; ts: number }[]>();
    for (const r of rows) rooms.set(r.room_id, [...(rooms.get(r.room_id) ?? []), { sender: r.sender, ts: Number(r.ts) }]);
    // Per user: each contact with the earliest time they first shared a DM.
    const contacts = new Map<string, Map<string, number>>();
    for (const members of rooms.values()) {
      if (members.length !== 2) continue;
      const [a, b] = members as [{ sender: string; ts: number }, { sender: string; ts: number }];
      if (a.sender === b.sender || !users.has(a.sender) || !users.has(b.sender)) continue;
      const at = Math.max(a.ts, b.ts);
      for (const [user, other] of [[a.sender, b.sender], [b.sender, a.sender]] as const) {
        const known = contacts.get(user) ?? new Map<string, number>();
        known.set(other, Math.min(known.get(other) ?? at, at));
        contacts.set(user, known);
      }
    }
    await this.tx(async (q) => {
      for (const [user, known] of contacts) {
        if (known.size < 5) continue;
        const fifth = [...known.values()].sort((x, y) => x - y)[4]!;
        await this.put(q, this.uid(user), "contact_fifth", dayOf(fifth));
      }
    });
  }

  async close(): Promise<void> {
    await this.synapse?.end();
  }
}

export type FunnelStep = { step: string; users: number; of_signups: string; of_previous: string };
export type RetentionRow = { week: string; signups: number } & Record<string, string | number>;
/** Raw numbers behind the report. `due` counts the sign-ups whose day N is over; `kept` those active on day N. */
export type GrowthNumbers = {
  funnel: { step: string; users: number }[];
  retention: { week: string; signups: number; days: { day: number; kept: number; due: number }[] }[];
  totals: { event: string; users: number; count: number }[];
  /** Days from sign-up to contact_fifth per sign-up week (bipe-chat/bipe#752). null: fewer reached it than the rank. */
  contacts: { week: string; signups: number; reached: number; medianDays: number | null; p75Days: number | null; invitesAcceptedPerMember: number }[];
};

/**
 * The q-quantile (0.5 median, 0.75 p75) of the days to an event over a whole cohort of `signups` people, where people
 * who have not reached it count as later than everyone. `days` are those who reached it. null while the rank is past them.
 */
export function cohortQuantile(days: number[], signups: number, q: number): number | null {
  const rank = Math.ceil(q * signups);
  if (rank < 1 || rank > days.length) return null;
  return [...days].sort((a, b) => a - b)[rank - 1]!;
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");

/**
 * Funnel over every recorded sign-up since `since` (a user counts at a step only with every earlier step), and
 * retention by sign-up week: the share with the retention event on day N, out of those whose day N is over.
 */
export async function growthNumbers(db: Db, since: string): Promise<GrowthNumbers> {
  const funnelEvents = growthRules.funnel;
  const { rows } = await db.query<{ uid: string; events: string[] }>(
    `SELECT s.uid, array_agg(DISTINCT g.event) AS events
       FROM growth_events s JOIN growth_events g ON g.uid = s.uid AND g.event = ANY($2)
      WHERE s.event = 'signup_done' AND s.day >= $1::date GROUP BY s.uid`,
    [since, funnelEvents],
  );
  const funnel = funnelEvents.map((step, k) => ({
    step,
    users: rows.filter((r) => funnelEvents.slice(0, k + 1).every((e) => r.events.includes(e))).length,
  }));

  const today = dayOf(Date.now());
  const cohort = await db.query<{ week: string; age: number; offsets: number[] | null }>(
    `SELECT to_char(date_trunc('week', s.day), 'YYYY-MM-DD') AS week, ($2::date - s.day) AS age,
            array_agg(g.day - s.day) FILTER (WHERE g.uid IS NOT NULL) AS offsets
       FROM growth_events s
       LEFT JOIN growth_events g ON g.uid = s.uid AND g.event = $3
      WHERE s.event = 'signup_done' AND s.day >= $1::date
      GROUP BY s.uid, s.day ORDER BY 1`,
    [since, today, growthRules.retentionEvent],
  );
  const weeks = new Map<string, typeof cohort.rows>();
  for (const r of cohort.rows) weeks.set(r.week, [...(weeks.get(r.week) ?? []), r]);
  const retention = [...weeks].map(([week, people]) => ({
    week,
    signups: people.length,
    days: growthRules.retentionDays.map((day) => {
      const due = people.filter((p) => p.age > day);
      return { day, kept: due.filter((p) => p.offsets?.includes(day)).length, due: due.length };
    }),
  }));

  const all = await db.query<{ event: string; users: number; count: number }>(
    "SELECT event, count(DISTINCT uid)::int AS users, sum(n)::int AS count FROM growth_events WHERE day >= $1::date GROUP BY 1 ORDER BY 1",
    [since],
  );
  const fifth = await db.query<{ week: string; days: number | null; accepted: number }>(
    `SELECT to_char(date_trunc('week', s.day), 'YYYY-MM-DD') AS week,
            (SELECT min(f.day) - s.day FROM growth_events f WHERE f.uid = s.uid AND f.event = 'contact_fifth') AS days,
            (SELECT coalesce(sum(r.n), 0)::int FROM growth_events r WHERE r.uid = s.uid AND r.event = 'invite_redeemed') AS accepted
       FROM growth_events s
      WHERE s.event = 'signup_done' AND s.day >= $1::date ORDER BY 1`,
    [since],
  );
  const contactWeeks = new Map<string, typeof fifth.rows>();
  for (const r of fifth.rows) contactWeeks.set(r.week, [...(contactWeeks.get(r.week) ?? []), r]);
  const contacts = [...contactWeeks].map(([week, people]) => {
    const days = people.filter((p) => p.days !== null).map((p) => Math.max(0, Number(p.days)));
    const accepted = people.reduce((sum, p) => sum + Number(p.accepted), 0);
    return {
      week,
      signups: people.length,
      reached: days.length,
      medianDays: cohortQuantile(days, people.length, 0.5),
      p75Days: cohortQuantile(days, people.length, 0.75),
      invitesAcceptedPerMember: Math.round((100 * accepted) / people.length) / 100,
    };
  });
  return { funnel, retention, totals: all.rows, contacts };
}

/** The same numbers as text tables, for the CLI. */
export type ContactRow = { week: string; signups: number; reached: string; median_days: number | string; p75_days: number | string; invites_accepted_per_member: number };

export async function growthReport(db: Db, since: string): Promise<{ funnel: FunnelStep[]; retention: RetentionRow[]; totals: Record<string, number>; contacts: ContactRow[] }> {
  const g = await growthNumbers(db, since);
  const first = g.funnel[0]?.users ?? 0;
  const funnel = g.funnel.map((f, k) => ({
    step: f.step,
    users: f.users,
    of_signups: pct(f.users, first),
    of_previous: k === 0 ? "-" : pct(f.users, g.funnel[k - 1]!.users),
  }));
  const retention = g.retention.map((w) => {
    const row: RetentionRow = { week: w.week, signups: w.signups };
    for (const d of w.days) row[`d${d.day}`] = d.due ? `${d.kept}/${d.due} ${pct(d.kept, d.due)}` : "-";
    return row;
  });
  const totals: Record<string, number> = {};
  for (const r of g.totals) {
    totals[`${r.event} (users)`] = r.users;
    totals[`${r.event} (count)`] = r.count;
  }
  const contacts = g.contacts.map((w) => ({
    week: w.week,
    signups: w.signups,
    reached: `${w.reached}/${w.signups} ${pct(w.reached, w.signups)}`,
    median_days: w.medianDays ?? "-",
    p75_days: w.p75Days ?? "-",
    invites_accepted_per_member: w.invitesAcceptedPerMember,
  }));
  return { funnel, retention, totals, contacts };
}
