import { createHmac } from "node:crypto";
import pg from "pg";
import type { Db } from "./db.js";
import { profileFactRules } from "./registry.js";

// Account age and profile change facts (ADR 0049, bipe-chat/bipe#598; contract POST /v1/profile-facts). The API keeps
// dates only: a change row (user, kind, source, time) for windowDays, and per account one HMAC digest of the current
// display name and avatar URL to notice a change. Never a name, a photo or an avatar URL. Matrix profile changes come
// from the Synapse database through the read-only role bipe_growth: it needs SELECT on profiles (user_id, displayname,
// avatar_url) and users (name, creation_ts) (bipe-infra scripts/setup-growth-role.sh). Public profile edits (ADR 0041)
// are written by profiles.ts. Never log a user ID next to a change.

const LOCK = 7140211;
const BATCH = 5000;
const SYNC_MS = 15 * 60_000;
const PRUNE_MS = 24 * 3_600_000;

export type ProfileChangeKind = "name" | "photo";

/** Writes one change row. `q` may be a transaction client. */
export async function recordProfileChange(
  q: Pick<pg.PoolClient, "query">,
  userId: string,
  kind: ProfileChangeKind,
  source: "matrix" | "public",
): Promise<void> {
  await q.query("INSERT INTO profile_changes (user_id, kind, source) VALUES ($1, $2, $3)", [userId, kind, source]);
}

export class ProfileFacts {
  private readonly synapse: Pick<pg.Pool, "query"> | null;
  private running = false;

  /** `opts.synapse` replaces the pool in tests. */
  constructor(
    private readonly db: Db,
    private readonly opts: { secret?: string; synapseUrl?: string; serverName: string; synapse?: Pick<pg.Pool, "query"> },
  ) {
    this.synapse = opts.synapse ?? (opts.synapseUrl ? new pg.Pool({ connectionString: opts.synapseUrl, max: 2 }) : null);
  }

  /** Matrix profile changes need both the Synapse database and the digest key. */
  get syncEnabled(): boolean {
    return this.synapse !== null && this.opts.secret !== undefined;
  }

  private digest(userId: string, kind: ProfileChangeKind, value: string | null): string {
    return createHmac("sha256", this.opts.secret!).update(`profile\n${kind}\n${userId}\n${value ?? ""}`, "utf8").digest("hex");
  }

  /**
   * POST /v1/profile-facts: per Matrix ID, the creation time (Synapse users.creation_ts, in seconds) and the change
   * dates in the window, oldest first. IDs without a creation time and without changes are absent.
   */
  async facts(userIds: string[]) {
    const ids = [...new Set(userIds)];
    const { rows } = await this.db.query<{ user_id: string; kind: ProfileChangeKind; changed_at: Date }>(
      `SELECT user_id, kind, changed_at FROM profile_changes
       WHERE user_id = ANY($1) AND changed_at > now() - make_interval(days => $2)
       ORDER BY changed_at, id`,
      [ids, profileFactRules.windowDays],
    );
    const created = new Map<string, Date>();
    if (this.synapse) {
      const local = ids.filter((id) => id.endsWith(`:${this.opts.serverName}`));
      if (local.length) {
        try {
          const res = await this.synapse.query<{ name: string; creation_ts: string | number | null }>(
            "SELECT name, creation_ts FROM users WHERE name = ANY($1)",
            [local],
          );
          for (const r of res.rows) if (r.creation_ts !== null) created.set(r.name, new Date(Number(r.creation_ts) * 1000));
        } catch {
          // No grant or no Synapse now: the facts go out without creation times.
        }
      }
    }
    const facts = new Map<string, { user_id: string; created_at?: string; name_changes: string[]; photo_changes: string[] }>();
    const entry = (id: string) => {
      let f = facts.get(id);
      if (!f) facts.set(id, (f = { user_id: id, name_changes: [], photo_changes: [] }));
      return f;
    };
    for (const id of ids) {
      const at = created.get(id);
      if (at) entry(id).created_at = at.toISOString();
    }
    for (const r of rows) (r.kind === "name" ? entry(r.user_id).name_changes : entry(r.user_id).photo_changes).push(r.changed_at.toISOString());
    return { facts: [...facts.values()] };
  }

  /**
   * One pass over Synapse profiles: a new account gets its digests without a change; a digest that differs is a change
   * now. Runs under an advisory lock, so two processes never count one change twice.
   */
  async sync(): Promise<number> {
    if (!this.syncEnabled || this.running) return 0;
    this.running = true;
    const client = await this.db.connect();
    let changes = 0;
    try {
      const { rows: locked } = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [LOCK]);
      if (!locked[0]?.ok) return 0;
      try {
        let after = "";
        for (;;) {
          const { rows } = await this.synapse!.query<{ user_id: string; displayname: string | null; avatar_url: string | null }>(
            "SELECT user_id, displayname, avatar_url FROM profiles WHERE user_id > $1 ORDER BY user_id LIMIT $2",
            [after, BATCH],
          );
          if (!rows.length) break;
          after = rows[rows.length - 1]!.user_id;
          changes += await this.applyBatch(client, rows);
          if (rows.length < BATCH) break;
        }
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [LOCK]);
      }
    } finally {
      client.release();
      this.running = false;
    }
    return changes;
  }

  private async applyBatch(
    client: pg.PoolClient,
    rows: { user_id: string; displayname: string | null; avatar_url: string | null }[],
  ): Promise<number> {
    const current = rows.map((r) => {
      const userId = `@${r.user_id}:${this.opts.serverName}`;
      return { userId, name: this.digest(userId, "name", r.displayname), photo: this.digest(userId, "photo", r.avatar_url) };
    });
    const { rows: known } = await client.query<{ user_id: string; name_digest: string; photo_digest: string }>(
      "SELECT user_id, name_digest, photo_digest FROM profile_snapshots WHERE user_id = ANY($1)",
      [current.map((c) => c.userId)],
    );
    const before = new Map(known.map((k) => [k.user_id, k]));
    let changes = 0;
    await client.query("BEGIN");
    try {
      for (const c of current) {
        const old = before.get(c.userId);
        if (old && old.name_digest === c.name && old.photo_digest === c.photo) continue;
        if (old && old.name_digest !== c.name) {
          await recordProfileChange(client, c.userId, "name", "matrix");
          changes++;
        }
        if (old && old.photo_digest !== c.photo) {
          await recordProfileChange(client, c.userId, "photo", "matrix");
          changes++;
        }
        await client.query(
          `INSERT INTO profile_snapshots (user_id, name_digest, photo_digest) VALUES ($1, $2, $3)
           ON CONFLICT (user_id) DO UPDATE SET name_digest = EXCLUDED.name_digest, photo_digest = EXCLUDED.photo_digest, seen_at = now()`,
          [c.userId, c.name, c.photo],
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    }
    return changes;
  }

  /** Change rows older than the window go. */
  async prune(): Promise<number> {
    const { rowCount } = await this.db.query("DELETE FROM profile_changes WHERE changed_at <= now() - make_interval(days => $1)", [
      profileFactRules.windowDays,
    ]);
    return rowCount ?? 0;
  }

  /** Sync every 15 minutes, prune every day. A failed run logs one line and the next run tries again. */
  start(): void {
    const sync = () => this.sync().catch((e) => console.error(`profile facts: sync failed: ${(e as Error).message}`));
    const prune = () => this.prune().catch((e) => console.error(`profile facts: prune failed: ${(e as Error).message}`));
    setTimeout(sync, 30_000).unref();
    setInterval(sync, SYNC_MS).unref();
    prune();
    setInterval(prune, PRUNE_MS).unref();
  }
}
