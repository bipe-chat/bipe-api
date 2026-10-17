import pg from "pg";
import { ApiError } from "./errors.js";
import { MIN_CELL } from "./staff-report.js";

// Staff report for bipe.chat/admin/visitas/ (ADR 0098): Umami visits in Brazil by state and city.
// Role bipe_growth reads only the Umami columns that bipe-infra scripts/setup-growth.sh grants.
// Umami takes the place from the visitor IP and keeps no IP. The report has no URL, referrer or session ID.
// Cities below MIN_CELL fold into one row per state with city null (bipe#371). States stay as they are.

type Count = { visitors: number; views: number };
export type VisitReport = {
  days: number;
  brazil: Count;
  other_countries: Count;
  states: (Count & { state: string | null })[];
  cities: (Count & { state: string | null; city: string | null })[];
};

const CITY_LIMIT = 200;

/** Cities below MIN_CELL become one row per state with city null; then the top CITY_LIMIT rows, most visitors first. */
function foldSmall(rows: (Count & { state: string | null; city: string })[]): VisitReport["cities"] {
  const out: VisitReport["cities"] = [];
  const rest = new Map<string | null, Count>();
  for (const r of rows) {
    if (r.visitors >= MIN_CELL) { out.push(r); continue; }
    const o = rest.get(r.state) ?? { visitors: 0, views: 0 };
    rest.set(r.state, { visitors: o.visitors + r.visitors, views: o.views + r.views });
  }
  for (const [state, c] of rest) out.push({ state, city: null, ...c });
  return out.sort((a, b) => b.visitors - a.visitors || b.views - a.views).slice(0, CITY_LIMIT);
}

export class Visits {
  private readonly pool: pg.Pool | null;

  constructor(url: string | undefined, private readonly websiteId: string) {
    this.pool = url ? new pg.Pool({ connectionString: url, max: 2 }) : null;
  }

  get enabled(): boolean {
    return this.pool !== null;
  }

  async report(days: number): Promise<VisitReport> {
    if (!this.pool) throw new ApiError("internal");
    // One row per session in the period, with its view count. event_type 1 is a page view.
    const base = `WITH s AS (
      SELECT e.session_id, count(*) FILTER (WHERE e.event_type = 1)::int AS views
      FROM website_event e
      WHERE e.website_id = $1 AND e.created_at > now() - make_interval(days => $2)
      GROUP BY e.session_id
    ), p AS (
      SELECT s.views, x.country, nullif(regexp_replace(coalesce(x.region, ''), '^BR-', ''), '') AS state, nullif(x.city, '') AS city
      FROM s JOIN session x ON x.session_id = s.session_id AND x.website_id = $1
    )`;
    const args = [this.websiteId, days];
    const [totals, states, cities] = await Promise.all([
      this.pool.query<{ brazil: boolean; visitors: number; views: number }>(
        `${base} SELECT country = 'BR' AS brazil, count(*)::int AS visitors, coalesce(sum(views), 0)::int AS views FROM p GROUP BY 1`, args),
      this.pool.query<Count & { state: string | null }>(
        `${base} SELECT state, count(*)::int AS visitors, coalesce(sum(views), 0)::int AS views FROM p WHERE country = 'BR' GROUP BY state ORDER BY visitors DESC, views DESC`, args),
      this.pool.query<Count & { state: string | null; city: string }>(
        `${base} SELECT state, city, count(*)::int AS visitors, coalesce(sum(views), 0)::int AS views FROM p
         WHERE country = 'BR' AND city IS NOT NULL GROUP BY state, city`, args),
    ]);
    const total = (brazil: boolean): Count => {
      const r = totals.rows.find((t) => t.brazil === brazil);
      return { visitors: r?.visitors ?? 0, views: r?.views ?? 0 };
    };
    return { days, brazil: total(true), other_countries: total(false), states: states.rows, cities: foldSmall(cities.rows) };
  }

  /** Brazil visitors (sessions) in the last `days` days, for the staff index (bipe#394). One cheap count. */
  async brazilVisitors(days: number): Promise<number> {
    if (!this.pool) throw new ApiError("internal");
    const { rows } = await this.pool.query<{ visitors: number }>(
      `SELECT count(DISTINCT e.session_id)::int AS visitors
         FROM website_event e JOIN session x ON x.session_id = e.session_id AND x.website_id = $1
        WHERE e.website_id = $1 AND e.created_at > now() - make_interval(days => $2) AND x.country = 'BR'`,
      [this.websiteId, days],
    );
    return rows[0]!.visitors;
  }

  /** Brazil visitors (sessions) per day in Brazil time, last `days` days, for /v1/admin/metrics. Days without visits are absent. */
  async brazilDaily(days: number): Promise<Map<string, number>> {
    if (!this.pool) throw new ApiError("internal");
    const { rows } = await this.pool.query<{ day: string; visitors: number }>(
      `SELECT to_char(e.created_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS day, count(DISTINCT e.session_id)::int AS visitors
         FROM website_event e JOIN session x ON x.session_id = e.session_id AND x.website_id = $1
        WHERE e.website_id = $1 AND e.created_at > now() - make_interval(days => $2) AND x.country = 'BR'
        GROUP BY 1`,
      [this.websiteId, days],
    );
    return new Map(rows.map((r) => [r.day, r.visitors]));
  }

  /** Retention check (bipe#381): event count, oldest event, events older than `limitDays`. */
  async age(limitDays: number): Promise<{ rows: number; oldest: string | null; over: number }> {
    if (!this.pool) throw new ApiError("internal");
    const { rows } = await this.pool.query<{ rows: number; oldest: Date | null; over: number }>(
      `SELECT count(*)::int AS rows, min(created_at) AS oldest,
              count(*) FILTER (WHERE created_at <= now() - make_interval(days => $2))::int AS over
         FROM website_event WHERE website_id = $1`,
      [this.websiteId, limitDays],
    );
    const r = rows[0]!;
    return { rows: r.rows, oldest: r.oldest?.toISOString() ?? null, over: r.over };
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }
}
