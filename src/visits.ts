import pg from "pg";
import { ApiError } from "./errors.js";

// Staff report for bipe.chat/admin/visitas/ (ADR 0098): Umami visits in Brazil by state and city.
// Role bipe_growth reads only the Umami columns that bipe-infra scripts/setup-growth.sh grants.
// Umami takes the place from the visitor IP and keeps no IP. The report has no URL, referrer or session ID.

type Count = { visitors: number; views: number };
export type VisitReport = {
  days: number;
  brazil: Count;
  other_countries: Count;
  states: (Count & { state: string | null })[];
  cities: (Count & { state: string | null; city: string })[];
};

const CITY_LIMIT = 200;

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
         WHERE country = 'BR' AND city IS NOT NULL GROUP BY state, city ORDER BY visitors DESC, views DESC LIMIT ${CITY_LIMIT}`, args),
    ]);
    const total = (brazil: boolean): Count => {
      const r = totals.rows.find((t) => t.brazil === brazil);
      return { visitors: r?.visitors ?? 0, views: r?.views ?? 0 };
    };
    return { days, brazil: total(true), other_countries: total(false), states: states.rows, cities: cities.rows };
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }
}
