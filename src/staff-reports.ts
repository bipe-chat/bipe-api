import pg from "pg";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { experimentReport } from "./experiments.js";
import { HANDLE_CHANGE_KEEP_DAYS } from "./handles.js";
import { PARTNER_KEEP_DAYS } from "./partners.js";
import { growthRules } from "./registry.js";
import { cell, MIN_CELL } from "./staff-report.js";
import type { Visits } from "./visits.js";

// Read-only staff reports for bipe.chat/admin/* (bipe#368). Each one returns aggregates or business records,
// never message content, IPs, emails or growth pseudonyms. Counts that tie a small group to an action go
// through cell() (bipe#371).

const ms = (d: Date | null) => d?.toISOString() ?? null;

/** Headline tests (bipe#376, ADR 0032): every experiment with its arms. */
export async function experimentsReport(db: Db) {
  const ids = await db.query<{ experiment: string; first_day: string; last_day: string }>(
    `SELECT experiment, to_char(min(day), 'YYYY-MM-DD') AS first_day, to_char(max(day), 'YYYY-MM-DD') AS last_day
       FROM experiment_counts GROUP BY 1 ORDER BY max(day) DESC`,
  );
  const experiments = [];
  for (const e of ids.rows) {
    const arms = await experimentReport(db, e.experiment);
    experiments.push({
      id: e.experiment,
      first_day: e.first_day,
      last_day: e.last_day,
      arms: arms.map((a) => ({ arm: a.arm, visitors: a.visitors, install_clicks: a.install_clicks, waitlist: cell(a.waitlist) })),
    });
  }
  return { experiments };
}

/** Waitlist (bipe#374, ADR 0089): who still waits, per platform, and how each released batch did. No email. */
export async function waitlistReport(db: Db) {
  const platforms = await db.query<{ platform: string; waiting: number; invited: number; oldest: Date | null }>(
    `SELECT platform, count(*) FILTER (WHERE invite_id IS NULL)::int AS waiting,
            count(*) FILTER (WHERE invite_id IS NOT NULL)::int AS invited,
            min(created_at) FILTER (WHERE invite_id IS NULL) AS oldest
       FROM waitlist GROUP BY platform ORDER BY platform`,
  );
  const batches = await db.query<{ note: string; sent: number; joined: number; expired: number; revoked: number }>(
    `SELECT i.note, count(*)::int AS sent,
            count(s.user_id)::int AS joined,
            count(*) FILTER (WHERE s.user_id IS NULL AND i.revoked_at IS NULL AND i.expires_at <= now())::int AS expired,
            count(*) FILTER (WHERE s.user_id IS NULL AND i.revoked_at IS NOT NULL)::int AS revoked
       FROM invites i LEFT JOIN signups s ON s.invite_id = i.id
      WHERE i.note LIKE 'waitlist-%' GROUP BY i.note ORDER BY i.note DESC`,
  );
  return {
    platforms: platforms.rows.map((p) => ({ ...p, oldest: ms(p.oldest) })),
    batches: batches.rows.map((b) => ({ ...b, joined: cell(b.joined) })),
  };
}

/** CNPJ claims (bipe#375, ADR 0042): business records, the same rows as `business list`. */
export async function businessReport(db: Db) {
  const { rows } = await db.query<{
    user_id: string; cnpj: string; status: string; reason: string | null; method: string | null;
    created_at: Date; verified_at: Date | null; ended_at: Date | null; legal_name: string | null; trade_name: string | null;
    registry_active: boolean | null; release_month: string | null; domains: number; domains_verified: number; last_checked: Date | null;
  }>(
    `SELECT c.user_id, c.cnpj, c.status, c.reason, c.method, c.created_at, c.verified_at, c.ended_at,
            r.legal_name, r.trade_name, r.active AS registry_active, r.release_month,
            (SELECT count(*)::int FROM business_domains d WHERE d.user_id = c.user_id) AS domains,
            (SELECT count(*)::int FROM business_domains d WHERE d.user_id = c.user_id AND d.verified_at IS NOT NULL) AS domains_verified,
            (SELECT max(d.last_checked_at) FROM business_domains d WHERE d.user_id = c.user_id) AS last_checked
       FROM business_claims c LEFT JOIN cnpj_registry r ON r.cnpj = c.cnpj
      ORDER BY c.created_at DESC`,
  );
  return {
    claims: rows.map((r) => ({ ...r, created_at: r.created_at.toISOString(), verified_at: ms(r.verified_at), ended_at: ms(r.ended_at), last_checked: ms(r.last_checked) })),
  };
}

/** Retention (bipe#381, ADR 0090): rows, oldest row and rows past the limit, per data item with a time limit. */
type RetentionItem = { id: string; limit_days: number | null; rows: number; oldest: string | null; over: number };

export class StaffReports {
  private readonly synapse: pg.Pool | null;

  constructor(private readonly db: Db, synapseUrl: string | undefined, private readonly visits: Visits) {
    this.synapse = synapseUrl ? new pg.Pool({ connectionString: synapseUrl, max: 1 }) : null;
  }

  /**
   * User reports (bipe#380): Synapse event_reports, newest first. Only what the reporter sent (reason and score)
   * and the room, to look it up in Element Admin. No reporter, no event, no message content.
   * Role bipe_growth has SELECT on these columns only (bipe-infra scripts/setup-growth.sh).
   */
  async reports(days: number) {
    if (!this.synapse) throw new ApiError("internal");
    const { rows } = await this.synapse.query<{ id: string; received_ts: string; room_id: string; reason: string | null; content: string | null }>(
      `SELECT id, received_ts, room_id, reason, content FROM event_reports
        WHERE received_ts > (extract(epoch FROM now()) * 1000)::bigint - $1::bigint * 86400000
        ORDER BY received_ts DESC LIMIT 500`,
      [days],
    );
    return {
      days,
      reports: rows.map((r) => {
        let score: number | null = null;
        try { const c = JSON.parse(r.content ?? "{}") as { score?: unknown }; if (typeof c.score === "number") score = c.score; } catch { /* no score */ }
        return { id: Number(r.id), received_at: new Date(Number(r.received_ts)).toISOString(), room_id: r.room_id, reason: r.reason, score };
      }),
    };
  }

  async retention(): Promise<{ items: RetentionItem[] }> {
    const one = async (id: string, limitDays: number | null, sql: string, args: unknown[] = []): Promise<RetentionItem> => {
      const { rows } = await this.db.query<{ rows: number; oldest: Date | null; over: number }>(sql, args);
      const r = rows[0]!;
      return { id, limit_days: limitDays, rows: r.rows, oldest: ms(r.oldest), over: r.over };
    };
    const items = await Promise.all([
      one("handle-history", HANDLE_CHANGE_KEEP_DAYS,
        "SELECT count(*)::int AS rows, min(changed_at) AS oldest, count(*) FILTER (WHERE changed_at <= now() - make_interval(days => $1))::int AS over FROM handle_changes",
        [HANDLE_CHANGE_KEEP_DAYS]),
      one("partner-requests", PARTNER_KEEP_DAYS,
        "SELECT count(*)::int AS rows, min(created_at) AS oldest, count(*) FILTER (WHERE created_at <= now() - make_interval(days => $1))::int AS over FROM partner_requests",
        [PARTNER_KEEP_DAYS]),
      one("app-growth", growthRules.retentionDaysKept,
        "SELECT count(*)::int AS rows, min(day)::timestamptz AS oldest, count(*) FILTER (WHERE day < current_date - $1::int)::int AS over FROM growth_events",
        [growthRules.retentionDaysKept]),
      // Waitlist: an entry must go once its invite is used, expired or revoked.
      one("waitlist", null,
        `SELECT count(*)::int AS rows, min(w.created_at) AS oldest,
                count(*) FILTER (WHERE i.id IS NOT NULL AND (i.revoked_at IS NOT NULL OR i.expires_at <= now() - interval '1 day'
                  OR EXISTS (SELECT 1 FROM signups s WHERE s.invite_id = i.id AND s.created_at <= now() - interval '1 day')))::int AS over
           FROM waitlist w LEFT JOIN invites i ON i.id = w.invite_id`),
      one("signup-replays", 7,
        "SELECT count(*)::int AS rows, min(created_at) AS oldest, count(*) FILTER (WHERE created_at <= now() - interval '8 days')::int AS over FROM signup_replays"),
    ]);
    if (this.visits.enabled) items.push({ id: "site-visits", limit_days: 395, ...(await this.visits.age(395)) });
    return { items };
  }

  /**
   * Staff index (bipe#394): one small object per staff page, so /admin/ makes one call. Each part runs alone:
   * a failed or off source gives null for its page, never a 500 for the whole index. Counts of people go
   * through cell(). Counts of business records and reports stay plain: their pages list the rows.
   */
  async summary() {
    const part = async <T>(key: string, f: () => Promise<T>): Promise<T | null> => {
      try { return await f(); } catch (e) {
        // Off sources throw ApiError("internal"); log only real failures, without query text or values.
        if (!(e instanceof ApiError)) console.error(`summary ${key} failed: ${(e as Error).name}`);
        return null;
      }
    };
    const count = async (sql: string, args: unknown[] = []) => (await this.db.query<{ n: number }>(sql, args)).rows[0]!.n;
    const [crescimento, convites, visitas, experimentos, espera, empresas, denuncias, lgpd] = await Promise.all([
      // Sign-ups from the signups table: it is on without growth events (BIPE_GROWTH_HMAC_SECRET).
      part("crescimento", async () => ({
        signups_7d: cell(await count("SELECT count(*)::int AS n FROM signups WHERE created_at > now() - interval '7 days'")),
      })),
      part("convites", async () => ({
        joins_30d: cell(await count(
          `SELECT count(*)::int AS n FROM signups s JOIN invites i ON i.id = s.invite_id
            WHERE i.created_by IS NOT NULL AND s.created_at > now() - interval '30 days'`)),
      })),
      part("visitas", async () => ({ brazil_7d: cell(await this.visits.brazilVisitors(7)) })),
      // The API does not read headlineTest in bipe-shared product.json, so "active" is the experiment with the newest day.
      part("experimentos", async () => {
        const { rows } = await this.db.query<{ experiment: string; visitors: number }>(
          `SELECT experiment, coalesce(sum(n) FILTER (WHERE event = 'assign'), 0)::int AS visitors
             FROM experiment_counts GROUP BY experiment ORDER BY max(day) DESC LIMIT 1`);
        const r = rows[0];
        if (!r) throw new ApiError("internal");
        return { id: r.experiment, visitors: r.visitors };
      }),
      part("espera", async () => ({ waiting: await count("SELECT count(*)::int AS n FROM waitlist WHERE invite_id IS NULL") })),
      part("empresas", async () => {
        const { rows } = await this.db.query<{ awaiting_proof: number; verified: number }>(
          `SELECT count(*) FILTER (WHERE status = 'awaiting_proof')::int AS awaiting_proof,
                  count(*) FILTER (WHERE status = 'verified')::int AS verified FROM business_claims`);
        return rows[0]!;
      }),
      part("denuncias", async () => {
        if (!this.synapse) throw new ApiError("internal");
        const { rows } = await this.synapse.query<{ n: number }>(
          `SELECT count(id)::int AS n FROM event_reports
            WHERE received_ts > (extract(epoch FROM now()) * 1000)::bigint - 7 * 86400000`);
        return { reports_7d: rows[0]!.n };
      }),
      part("lgpd", async () => ({ over: (await this.retention()).items.reduce((sum, i) => sum + i.over, 0) })),
    ]);
    return { min_cell: MIN_CELL, crescimento, convites, visitas, experimentos, espera, empresas, denuncias, lgpd };
  }

  async close(): Promise<void> {
    await this.synapse?.end();
  }
}
