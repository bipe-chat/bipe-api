// Brand marks for resellers (bipe ADR 0162, bipe#483). A verified brand makes a single-use invite for one mark; the
// reseller accepts it on their work account. The brand or the reseller ends the mark at once. Signing lives in
// Badges.brandMarks(). Invite codes are stored only as SHA-256; brand_mark_events keeps who did what, by account ID.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { brandMarkRules } from "./registry.js";

const DAY_MS = 86_400_000;
const KEEP_ENDED_DAYS = 365;
const KEEP_UNUSED_INVITE_DAYS = 30;
// Serialises the accepts of one reseller, so two invites cannot pass the per-account limit together.
const LOCK = 7140162;
const CODE = /^[A-Za-z0-9_-]{16}$/;

type Brand = { name: string; cnpj: string };
export type BrandCheck = (userId: string) => Promise<Brand | null>;

type InviteRow = { id: string; label: string; created_at: Date; expires_at: Date };
type MarkAction = "invite_created" | "invite_cancelled" | "accepted" | "refused" | "ended";

const hashCode = (code: string) => createHash("sha256").update(code, "utf8").digest("hex");
const inviteJson = (r: InviteRow) => ({ id: r.id, label: r.label, created_at: r.created_at.toISOString(), expires_at: r.expires_at.toISOString() });

async function event(q: Db | pg.PoolClient, action: MarkAction, actor: string, ids: { mark?: string; invite?: string }) {
  await q.query("INSERT INTO brand_mark_events (mark_id, invite_id, action, actor_user_id) VALUES ($1, $2, $3, $4)", [
    ids.mark ?? null,
    ids.invite ?? null,
    action,
    actor,
  ]);
}

async function accountType(q: Db | pg.PoolClient, userId: string): Promise<string | null> {
  const { rows } = await q.query<{ account_type: string }>("SELECT account_type FROM signups WHERE user_id = $1", [userId]);
  return rows[0]?.account_type ?? null;
}

/** The code from a bare code, a /marca/#<code> link or a pasted message; null when none is there. */
export function brandMarkCode(raw: string): string | null {
  const found = raw.trim().match(/(?:^|[#/\s])([A-Za-z0-9_-]{16})(?=$|[\s.,;!?)])/);
  return found && CODE.test(found[1]!) ? found[1]! : null;
}

export class BrandMarks {
  constructor(
    private readonly db: Db,
    private readonly brandOf: BrandCheck,
    private readonly publicSiteUrl: string,
  ) {}

  /** POST /v1/me/brand-marks/invites. Only a company account with a verified claim grants (ADR 0162 point 1). */
  async createInvite(brandUserId: string, label: unknown, now = new Date()) {
    if (typeof label !== "string" || !brandMarkRules.labels.includes(label)) throw new ApiError("bad_request", "label");
    if ((await accountType(this.db, brandUserId)) !== "company" || !(await this.brandOf(brandUserId))) {
      throw new ApiError("brand_not_verified");
    }
    const code = randomBytes(12).toString("base64url");
    const id = randomUUID();
    const { rows } = await this.db.query<InviteRow>(
      `INSERT INTO brand_mark_invites (id, brand_user_id, label, code_hash, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, label, created_at, expires_at`,
      [id, brandUserId, label, hashCode(code), now, new Date(now.getTime() + brandMarkRules.inviteDays * DAY_MS)],
    );
    await event(this.db, "invite_created", brandUserId, { invite: id });
    return { invite: inviteJson(rows[0]!), code, link: `${this.publicSiteUrl.replace(/\/$/, "")}/marca/#${code}` };
  }

  /** DELETE /v1/me/brand-marks/invites/{id}: only the brand's own open invite. */
  async cancelInvite(brandUserId: string, inviteId: string) {
    const { rowCount } = await this.db.query(
      `UPDATE brand_mark_invites SET ended_at = now(), outcome = 'cancelled'
        WHERE id = $1::uuid AND brand_user_id = $2 AND ended_at IS NULL`,
      [inviteId, brandUserId],
    ).catch(() => ({ rowCount: 0 }));
    if (!rowCount) throw new ApiError("not_found");
    await event(this.db, "invite_cancelled", brandUserId, { invite: inviteId });
  }

  /** GET /v1/me/brand-marks/granted: open invites and the accounts with an active mark. Nothing about their chats. */
  async granted(brandUserId: string, now = new Date()) {
    const invites = await this.db.query<InviteRow>(
      `SELECT id, label, created_at, expires_at FROM brand_mark_invites
        WHERE brand_user_id = $1 AND ended_at IS NULL AND expires_at > $2 ORDER BY created_at`,
      [brandUserId, now],
    );
    const marks = await this.db.query<{ id: string; reseller_user_id: string; label: string; granted_at: Date }>(
      `SELECT id, reseller_user_id, label, granted_at FROM brand_marks
        WHERE brand_user_id = $1 AND ended_at IS NULL ORDER BY granted_at, id`,
      [brandUserId],
    );
    return {
      invites: invites.rows.map(inviteJson),
      marks: marks.rows.map((m) => ({ id: m.id, reseller: m.reseller_user_id, label: m.label, granted_at: m.granted_at.toISOString() })),
    };
  }

  /** GET /v1/me/brand-marks: the marks the caller holds, with the brand's current name. */
  async held(resellerUserId: string) {
    const { rows } = await this.db.query<{ id: string; brand_user_id: string; label: string; granted_at: Date }>(
      `SELECT id, brand_user_id, label, granted_at FROM brand_marks
        WHERE reseller_user_id = $1 AND ended_at IS NULL ORDER BY granted_at, id`,
      [resellerUserId],
    );
    const marks = [];
    for (const m of rows) {
      const brand = await this.brandOf(m.brand_user_id);
      marks.push({ id: m.id, brand: m.brand_user_id, brand_name: brand?.name ?? "", label: m.label, granted_at: m.granted_at.toISOString() });
    }
    return { marks };
  }

  /** GET /v1/brand-marks/invites/{code}. Every unusable code is the same not_found. */
  async preview(rawCode: string, now = new Date()) {
    const { invite, brand } = await this.usable(this.db, rawCode, now, false);
    return { brand: invite.brand_user_id, brand_name: brand.name, cnpj: brand.cnpj, label: invite.label, expires_at: invite.expires_at.toISOString() };
  }

  /** POST /v1/brand-marks/invites/{code}/accept. No mark without the reseller's yes (ADR 0162 point 2). */
  async accept(resellerUserId: string, rawCode: string, now = new Date()) {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [LOCK, resellerUserId]);
      const { invite, brand } = await this.usable(client, rawCode, now, true);
      if ((await accountType(client, resellerUserId)) !== "company") throw new ApiError("bad_request", "not_work_account");
      if (invite.brand_user_id === resellerUserId) throw new ApiError("bad_request", "own_brand");
      const active = await client.query<{ brand_user_id: string }>(
        "SELECT brand_user_id FROM brand_marks WHERE reseller_user_id = $1 AND ended_at IS NULL",
        [resellerUserId],
      );
      if (active.rows.some((r) => r.brand_user_id === invite.brand_user_id)) throw new ApiError("bad_request", "already_held");
      // The invite stays open, so the reseller can end another mark first and come back.
      if (active.rows.length >= brandMarkRules.maxPerAccount) throw new ApiError("brand_mark_limit");
      const id = randomUUID();
      const { rows } = await client.query<{ granted_at: Date }>(
        `INSERT INTO brand_marks (id, brand_user_id, reseller_user_id, label, invite_id, granted_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING granted_at`,
        [id, invite.brand_user_id, resellerUserId, invite.label, invite.id, now],
      );
      await client.query("UPDATE brand_mark_invites SET ended_at = $2, outcome = 'accepted' WHERE id = $1", [invite.id, now]);
      await event(client, "accepted", resellerUserId, { mark: id, invite: invite.id });
      await client.query("COMMIT");
      return { id, brand: invite.brand_user_id, brand_name: brand.name, label: invite.label, granted_at: rows[0]!.granted_at.toISOString() };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /** POST /v1/brand-marks/invites/{code}/refuse: the invite is used and no mark is made. */
  async refuse(resellerUserId: string, rawCode: string, now = new Date()) {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const { invite } = await this.usable(client, rawCode, now, true);
      await client.query("UPDATE brand_mark_invites SET ended_at = $2, outcome = 'refused' WHERE id = $1", [invite.id, now]);
      await event(client, "refused", resellerUserId, { invite: invite.id });
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /** DELETE /v1/me/brand-marks/{id}: the brand or the reseller ends the mark at once (ADR 0162 point 5). */
  async end(userId: string, markId: string, now = new Date()) {
    const { rowCount } = await this.db.query(
      `UPDATE brand_marks SET ended_at = $3, ended_by = $2
        WHERE id = $1::uuid AND ended_at IS NULL AND (brand_user_id = $2 OR reseller_user_id = $2)`,
      [markId, userId, now],
    ).catch(() => ({ rowCount: 0 }));
    if (!rowCount) throw new ApiError("not_found");
    await event(this.db, "ended", userId, { mark: markId });
  }

  /** Ended marks and events after 365 days; invites nobody used 30 days after they expire. */
  async prune(now = new Date()): Promise<number> {
    const ended = new Date(now.getTime() - KEEP_ENDED_DAYS * DAY_MS);
    const unused = new Date(now.getTime() - KEEP_UNUSED_INVITE_DAYS * DAY_MS);
    const marks = await this.db.query("DELETE FROM brand_marks WHERE ended_at < $1", [ended]);
    const events = await this.db.query("DELETE FROM brand_mark_events WHERE at < $1", [ended]);
    const invites = await this.db.query(
      `DELETE FROM brand_mark_invites WHERE (ended_at IS NULL AND expires_at < $1) OR (ended_at < $2 AND outcome <> 'accepted')
          OR (outcome = 'accepted' AND NOT EXISTS (SELECT 1 FROM brand_marks m WHERE m.invite_id = brand_mark_invites.id))`,
      [unused, unused],
    );
    return (marks.rowCount ?? 0) + (events.rowCount ?? 0) + (invites.rowCount ?? 0);
  }

  /** An open, unexpired invite whose brand still has its seal. `lock`: inside a transaction, FOR UPDATE. */
  private async usable(q: Db | pg.PoolClient, rawCode: string, now: Date, lock: boolean) {
    const code = brandMarkCode(rawCode);
    if (!code) throw new ApiError("not_found");
    const { rows } = await q.query<{ id: string; brand_user_id: string; label: string; expires_at: Date }>(
      `SELECT id, brand_user_id, label, expires_at FROM brand_mark_invites
        WHERE code_hash = $1 AND ended_at IS NULL AND expires_at > $2${lock ? " FOR UPDATE" : ""}`,
      [hashCode(code), now],
    );
    const invite = rows[0];
    if (!invite) throw new ApiError("not_found");
    const brand = await this.brandOf(invite.brand_user_id);
    if (!brand) throw new ApiError("not_found");
    return { invite, brand };
  }
}
