// Reach tiers and the first-contact budget (security.md rule 11, bipe-chat/bipe#39, bipe-chat/bipe#851). The tier of an
// account sets how many first contacts (src/reach.ts) it may start per rolling windowHours (registries/reach.json).
// Over the budget, may-invite answers { allow: false, reason: "reach_limit" } and the Synapse module refuses the invite
// with M_LIMIT_EXCEEDED. Contacts and invite pairs never reach this code (mayInvite). The budget is the first_contacts
// table itself: Postgres, shared by every API instance, kept across restarts; one inviter's takes run one at a time
// under REACH_LOCK. Budgets and thresholds come from the environment (config.ts REACH_*); REACH_DEFAULTS are the
// strategy's starting values (27 October 2026), for local runs. No score leaves this file: GET /v1/me/reach shows the
// tier, the budget and what raises it. Never log a user ID next to a tier.
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { REACH_LOCK, type Reach } from "./reach.js";
import { reachRules } from "./registry.js";

export const TIERS = ["unattested", "new", "normal", "verified", "company", "slowed"] as const;
export type Tier = (typeof TIERS)[number];

export const REACH_DEFAULTS = {
  budgets: { unattested: 5, new: 10, normal: 30, verified: 100, company: 100, slowed: 3 } as Record<Tier, number>,
  newDays: 7,
  feedbackDays: 30,
  slowedMinContacts: 10,
  slowedFactor: 3,
  slowedMinRate: 0.1,
};

export type ReachSettings = typeof REACH_DEFAULTS & { enforce: boolean; defaulted: string[] };

type ReachEnv = Pick<Config, "REACH_LIMITS" | "REACH_BUDGETS" | "REACH_NEW_DAYS" | "REACH_FEEDBACK_DAYS" | "REACH_SLOWED_MIN_CONTACTS" | "REACH_SLOWED_FACTOR" | "REACH_SLOWED_MIN_RATE">;

/** The settings from the environment. `defaulted` names every value that fell back to REACH_DEFAULTS. */
export function reachSettings(env: Partial<ReachEnv>): ReachSettings {
  const defaulted: string[] = [];
  const pick = <T>(name: string, value: T | undefined, fallback: T): T => {
    if (value === undefined) defaulted.push(name);
    return value ?? fallback;
  };
  const budgets = { ...REACH_DEFAULTS.budgets };
  const given = new Map((env.REACH_BUDGETS ?? "").split(",").filter(Boolean).map((p) => p.split("=") as [Tier, string]));
  for (const tier of TIERS) {
    if (given.has(tier)) budgets[tier] = Number(given.get(tier));
    else defaulted.push(`REACH_BUDGETS.${tier}`);
  }
  return {
    enforce: env.REACH_LIMITS ?? true,
    budgets,
    newDays: pick("REACH_NEW_DAYS", env.REACH_NEW_DAYS, REACH_DEFAULTS.newDays),
    feedbackDays: pick("REACH_FEEDBACK_DAYS", env.REACH_FEEDBACK_DAYS, REACH_DEFAULTS.feedbackDays),
    slowedMinContacts: pick("REACH_SLOWED_MIN_CONTACTS", env.REACH_SLOWED_MIN_CONTACTS, REACH_DEFAULTS.slowedMinContacts),
    slowedFactor: pick("REACH_SLOWED_FACTOR", env.REACH_SLOWED_FACTOR, REACH_DEFAULTS.slowedFactor),
    slowedMinRate: pick("REACH_SLOWED_MIN_RATE", env.REACH_SLOWED_MIN_RATE, REACH_DEFAULTS.slowedMinRate),
    defaulted,
  };
}

/** The step that raises the budget (contract ReachStatus.raise_by). */
export function raiseBy(tier: Tier): "verify" | "wait" | null {
  if (tier === "new" || tier === "normal") return "verify";
  if (tier === "slowed") return "wait";
  return null;
}

type Queryable = { query: Db["query"] };
const MEDIAN_CACHE_MS = 3_600_000;

export class ReachTiers {
  private median: { at: number; value: number } | null = null;

  constructor(
    private readonly db: Db,
    private readonly reach: Reach,
    readonly settings: ReachSettings,
    private readonly verifiedBrand: (userId: string) => Promise<unknown | null>,
  ) {}

  /** For the start log only: never the values, which are not public. */
  get state(): string {
    if (!this.reach.enabled) return "off (no first-contact record)";
    const mode = this.settings.enforce ? "on" : "record only (REACH_LIMITS=off)";
    return this.settings.defaulted.length ? `${mode}; starting values for ${this.settings.defaulted.length} settings (set REACH_* in production)` : mode;
  }

  /**
   * The tier. Order: slowed, unattested, company, verified, new, normal. Attestation is the sign-up's (signups.attested);
   * a row from before bipe#851 has none and counts as unattested, except a company account (ADR 0087: always attested).
   * An account without a signups row (made by hand in MAS) is unattested.
   */
  async tierOf(userId: string, q: Queryable = this.db, now = new Date()): Promise<Tier> {
    if (await this.slowed(userId, q)) return "slowed";
    const { rows } = await q.query<{ created_at: Date; attested: boolean | null; account_type: string }>(
      "SELECT created_at, attested, account_type FROM signups WHERE user_id = $1",
      [userId],
    );
    const signup = rows[0];
    if (!signup || !(signup.attested ?? signup.account_type === "company")) return "unattested";
    if (await this.verifiedBrand(userId)) return "company";
    const { rowCount } = await q.query("SELECT 1 FROM person_verifications WHERE user_id = $1 AND verified_name <> ''", [userId]);
    if (rowCount) return "verified";
    return now.getTime() - signup.created_at.getTime() < this.settings.newDays * 86_400_000 ? "new" : "normal";
  }

  /** The caller's state for GET /v1/me/reach. */
  async status(userId: string, now = new Date()) {
    if (!this.reach.enabled) throw new ApiError("internal", "reach_unavailable");
    const tier = await this.tierOf(userId, this.db, now);
    const { n, oldest } = await this.reach.sentWithin(this.db, userId, reachRules.windowHours, now);
    return {
      tier,
      budget: this.settings.budgets[tier],
      used: n,
      resets_at: oldest ? new Date(oldest.getTime() + reachRules.windowHours * 3_600_000).toISOString() : null,
      raise_by: raiseBy(tier),
    };
  }

  /**
   * Takes one unit of the inviter's budget and records the first contact, or answers false when the budget is used.
   * With REACH_LIMITS=off it always records. Without the first-contact record it allows and records nothing.
   */
  async take(inviter: string, invitee: string, roomId: string | null, now = new Date()): Promise<boolean> {
    if (!this.reach.enabled) return true;
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [REACH_LOCK, inviter]);
      if (this.settings.enforce) {
        const tier = await this.tierOf(inviter, client, now);
        const { n } = await this.reach.sentWithin(client, inviter, reachRules.windowHours, now);
        if (n >= this.settings.budgets[tier]) {
          await client.query("ROLLBACK");
          return false;
        }
      }
      await this.reach.insert(client, inviter, invitee, roomId, now);
      await client.query("COMMIT");
      return true;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Slowed: at least slowedMinContacts first contacts in feedbackDays, and blocks plus reports per first contact at or
   * above max(slowedFactor x the median rate of such senders, slowedMinRate).
   */
  private async slowed(userId: string, q: Queryable): Promise<boolean> {
    const { rows } = await q.query<{ sent: number; bad: number }>(
      `SELECT coalesce(sum(sent), 0)::int AS sent, coalesce(sum(blocked + reported), 0)::int AS bad FROM reach_daily
        WHERE user_id = $1 AND day > (now() AT TIME ZONE 'America/Sao_Paulo')::date - $2::int`,
      [userId, this.settings.feedbackDays],
    );
    const { sent, bad } = rows[0]!;
    if (sent < this.settings.slowedMinContacts) return false;
    const threshold = Math.max(this.settings.slowedFactor * (await this.medianRate(q)), this.settings.slowedMinRate);
    return bad / sent >= threshold;
  }

  private async medianRate(q: Queryable): Promise<number> {
    if (this.median && Date.now() - this.median.at < MEDIAN_CACHE_MS) return this.median.value;
    const { rows } = await q.query<{ median: number | null }>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY bad::float8 / sent) AS median FROM (
         SELECT sum(sent) AS sent, sum(blocked + reported) AS bad FROM reach_daily
          WHERE day > (now() AT TIME ZONE 'America/Sao_Paulo')::date - $1::int GROUP BY user_id) s
        WHERE sent >= $2`,
      [this.settings.feedbackDays, this.settings.slowedMinContacts],
    );
    this.median = { at: Date.now(), value: rows[0]?.median ?? 0 };
    return this.median.value;
  }
}
