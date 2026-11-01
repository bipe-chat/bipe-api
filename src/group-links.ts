// Group links (ADR 0184, bipe-chat/bipe#744): one link brings people into one group. The groups service account
// (registries/official-accounts.json role groups) is a member of the group with invite power and invites each person
// who has the link. It has no E2EE device, so it gets no room keys and reads no message: it reads room state only
// (name, members, power levels). A link from an admin with a badge also signs people up past the waitlist.
import type pg from "pg";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { extractInviteCode, inviteHash, newInviteCode } from "./invites.js";

/** ADR 0184: the same life as a waitlist invite (ADR 0089). */
export const GROUP_LINK_DAYS = 14;
/** ADR 0184: the room member limit until a group size ADR. communities.md proposes about 1,024 members. */
export const GROUP_LINK_MAX_SIGNUPS = 1024;
/** The power level of a group admin in Bipe (group-members admin role). */
const ADMIN_LEVEL = 50;
// Room previews are public: a short cache keeps crawler and page reads off Synapse.
const STATE_CACHE_MS = 60_000;

export interface RoomStateEvent {
  type: string;
  state_key: string;
  sender: string;
  content: Record<string, unknown>;
}

/** What the service account does in Synapse. Tests give a fake. */
export interface GroupRooms {
  readonly userId: string;
  join(roomId: string): Promise<void>;
  state(roomId: string): Promise<RoomStateEvent[]>;
  invite(roomId: string, userId: string): Promise<void>;
  leave(roomId: string): Promise<void>;
}

/** A refusal from Synapse (403 or 404): the service account is not in the room, or may not do this. */
export class RoomRefused extends Error {
  constructor(readonly what: string, readonly status: number) {
    super(`groups ${what}: HTTP ${status}`);
  }
}

/** Client-server API calls with the service account's token. Errors carry the call name and the status only. */
export class MatrixGroupRooms implements GroupRooms {
  constructor(private readonly synapseUrl: string, private readonly token: string, readonly userId: string) {}

  async join(roomId: string): Promise<void> {
    await this.call("join", "POST", `/join/${encodeURIComponent(roomId)}`, {});
  }

  async state(roomId: string): Promise<RoomStateEvent[]> {
    const body = await this.call("state", "GET", `/rooms/${encodeURIComponent(roomId)}/state`);
    return Array.isArray(body) ? body : [];
  }

  async invite(roomId: string, userId: string): Promise<void> {
    await this.call("invite", "POST", `/rooms/${encodeURIComponent(roomId)}/invite`, { user_id: userId });
  }

  async leave(roomId: string): Promise<void> {
    await this.call("leave", "POST", `/rooms/${encodeURIComponent(roomId)}/leave`, {});
  }

  private async call(what: string, method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.synapseUrl.replace(/\/$/, "")}/_matrix/client/v3${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 403 || res.status === 404) throw new RoomRefused(what, res.status);
    if (!res.ok) throw new Error(`groups ${what}: HTTP ${res.status}`);
    return res.json();
  }
}

/** The facts the routes need from the room state. */
export interface RoomFacts {
  name: string | null;
  joined: string[];
  membership(userId: string): string | null;
  level(userId: string): number;
  inviteLevel: number;
}

export function roomFacts(events: RoomStateEvent[]): RoomFacts {
  const of = (type: string, key = ""): Record<string, unknown> => events.find((e) => e.type === type && e.state_key === key)?.content ?? {};
  const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const create = of("m.room.create");
  const pl = of("m.room.power_levels");
  const users = record(pl["users"]);
  const usersDefault = num(pl["users_default"], 0);
  // Room version 12 (MSC4289): the creators have the top power level without an entry in users.
  const version: unknown = create["room_version"];
  const v12 = typeof version === "string" && /^(1[2-9]|[2-9]\d)$/.test(version);
  const creatorEvent = events.find((e) => e.type === "m.room.create" && e.state_key === "");
  const additional: unknown = create["additional_creators"];
  const extra = Array.isArray(additional) ? additional.filter((u): u is string => typeof u === "string") : [];
  const creators = new Set<string>(v12 && creatorEvent ? [creatorEvent.sender, ...extra] : []);
  const membership = new Map<string, string>();
  for (const e of events) {
    const m: unknown = e.content["membership"];
    if (e.type === "m.room.member" && typeof m === "string") membership.set(e.state_key, m);
  }
  const name: unknown = of("m.room.name")["name"];
  return {
    name: typeof name === "string" && name.trim() !== "" ? name.trim() : null,
    joined: [...membership].filter(([, m]) => m === "join").map(([u]) => u),
    membership: (userId) => membership.get(userId) ?? null,
    level: (userId) => (creators.has(userId) ? Number.POSITIVE_INFINITY : num(users[userId], usersDefault)),
    inviteLevel: num(pl["invite"], 0),
  };
}

const isAdmin = (facts: RoomFacts, userId: string) => facts.membership(userId) === "join" && facts.level(userId) >= ADMIN_LEVEL;

interface LinkRow {
  id: string;
  room_id: string;
  created_by: string | null;
  signs_up: boolean;
  signups: number;
  created_at: Date;
  expires_at: Date;
}

const ACTIVE = "revoked_at IS NULL AND expires_at > now()";

export const groupLinkUrl = (siteUrl: string, code: string) => `${siteUrl.replace(/\/$/, "")}/g/${code}`;

export interface GroupLinkDeps {
  db: Db;
  rooms: GroupRooms | null;
  /** True when the account has a badge (CNPJ, Pix or gov.br). */
  verified(userId: string): Promise<boolean>;
  siteUrl: string;
}

export class GroupLinks {
  private readonly cache = new Map<string, { at: number; facts: RoomFacts }>();

  constructor(private readonly deps: GroupLinkDeps) {}

  get state(): string {
    return this.deps.rooms ? `on (${this.deps.rooms.userId})` : "off (no GROUPS_ACCESS_TOKEN)";
  }

  private rooms(): GroupRooms {
    if (!this.deps.rooms) throw new ApiError("internal", "group_links_unavailable");
    return this.deps.rooms;
  }

  /** The room state as the service account sees it. null when it is not in the room. */
  private async facts(roomId: string, fresh = false): Promise<RoomFacts | null> {
    const hit = this.cache.get(roomId);
    if (!fresh && hit && Date.now() - hit.at < STATE_CACHE_MS) return hit.facts;
    try {
      const facts = roomFacts(await this.rooms().state(roomId));
      if (facts.membership(this.rooms().userId) !== "join") return null;
      this.cache.set(roomId, { at: Date.now(), facts });
      if (this.cache.size > 5000) this.cache.delete(this.cache.keys().next().value!);
      return facts;
    } catch (e) {
      if (e instanceof RoomRefused) return null;
      throw e;
    }
  }

  async create(userId: string, roomId: string) {
    if (!roomId.startsWith("!")) throw new ApiError("bad_request", "room_id");
    const rooms = this.rooms();
    // The app invited the service account first. A join of a room it is already in changes nothing.
    try {
      await rooms.join(roomId);
    } catch (e) {
      if (e instanceof RoomRefused) throw new ApiError("group_link_no_access");
      throw e;
    }
    const facts = await this.facts(roomId, true);
    if (!facts) throw new ApiError("group_link_no_access");
    if (!isAdmin(facts, userId)) throw new ApiError("not_found");
    if (facts.level(rooms.userId) < facts.inviteLevel) throw new ApiError("group_link_no_access");
    const signsUp = await this.deps.verified(userId);
    const code = newInviteCode();
    const client = await this.deps.db.connect();
    try {
      await client.query("BEGIN");
      // One active link per admin and group: a new link ends the earlier one.
      await client.query(`UPDATE group_links SET revoked_at = now() WHERE created_by = $1 AND room_id = $2 AND ${ACTIVE}`, [userId, roomId]);
      const { rows } = await client.query<{ id: string; expires_at: Date }>(
        `INSERT INTO group_links (code_hash, room_id, created_by, signs_up, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(days => $5)) RETURNING id, expires_at`,
        [inviteHash(code), roomId, userId, signsUp, GROUP_LINK_DAYS],
      );
      await client.query("COMMIT");
      const row = rows[0]!;
      return { id: String(row.id), code, url: groupLinkUrl(this.deps.siteUrl, code), expires_at: row.expires_at.toISOString(), signs_up: signsUp };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async list(userId: string, roomId: string) {
    if (!roomId.startsWith("!")) throw new ApiError("bad_request", "room_id");
    const facts = await this.facts(roomId, true);
    // Without the service account in the room no link works, and the caller's level cannot be read.
    if (!facts) return { links: [] };
    if (!isAdmin(facts, userId)) throw new ApiError("not_found");
    const { rows } = await this.deps.db.query<LinkRow & { joined: string }>(
      `SELECT l.id, l.room_id, l.created_by, l.signs_up, l.signups, l.created_at, l.expires_at,
              (SELECT count(*) FROM group_link_joins j WHERE j.link_id = l.id) AS joined
       FROM group_links l WHERE l.room_id = $1 AND l.revoked_at IS NULL AND l.expires_at > now()
       ORDER BY l.created_at DESC LIMIT 20`,
      [roomId],
    );
    return {
      links: rows.map((r) => ({
        id: String(r.id),
        created_by: r.created_by ?? "",
        created_at: r.created_at.toISOString(),
        expires_at: r.expires_at.toISOString(),
        signs_up: r.signs_up,
        joined: Number(r.joined),
        signups: r.signups,
        signups_left: r.signs_up ? Math.max(0, GROUP_LINK_MAX_SIGNUPS - r.signups) : 0,
      })),
    };
  }

  /** The creator, or an admin of the group. Ended and foreign links are not_found. */
  async revoke(userId: string, linkId: string): Promise<void> {
    if (!/^[0-9]{1,18}$/.test(linkId)) throw new ApiError("not_found");
    const { rows } = await this.deps.db.query<LinkRow>(`SELECT id, room_id, created_by FROM group_links WHERE id = $1 AND ${ACTIVE}`, [linkId]);
    const row = rows[0];
    if (!row) throw new ApiError("not_found");
    if (row.created_by !== userId) {
      const facts = this.deps.rooms ? await this.facts(row.room_id, true) : null;
      if (!facts || !isAdmin(facts, userId)) throw new ApiError("not_found");
    }
    await this.deps.db.query("UPDATE group_links SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [linkId]);
    await this.leaveUnused(row.room_id);
  }

  /**
   * The service account leaves each group that has no active link left (revoked or expired), so it does not stay in
   * the member list with invite power. A new link brings it back: the app invites it again. Runs hourly for expiry.
   */
  async leaveUnused(roomId?: string): Promise<number> {
    if (!this.deps.rooms) return 0;
    const { rows } = await this.deps.db.query<{ room_id: string }>(
      `SELECT DISTINCT room_id FROM group_links g
       WHERE NOT service_left AND NOT (${ACTIVE}) AND ($1::text IS NULL OR room_id = $1)
         AND NOT EXISTS (SELECT 1 FROM group_links a WHERE a.room_id = g.room_id AND a.revoked_at IS NULL AND a.expires_at > now())`,
      [roomId ?? null],
    );
    let left = 0;
    for (const { room_id } of rows) {
      try {
        await this.deps.rooms.leave(room_id);
        left++;
      } catch (e) {
        // Not in the room any more (an admin removed it): nothing to leave. Anything else retries next hour.
        if (!(e instanceof RoomRefused)) {
          console.error(`group link: leave failed (${(e as Error).message})`);
          continue;
        }
      }
      this.cache.delete(room_id);
      await this.deps.db.query(
        `UPDATE group_links SET service_left = true WHERE room_id = $1 AND NOT (${ACTIVE})`,
        [room_id],
      );
    }
    return left;
  }

  private async active(text: string): Promise<LinkRow | null> {
    const code = extractInviteCode(text);
    if (!code) return null;
    const { rows } = await this.deps.db.query<LinkRow>(
      `SELECT id, room_id, created_by, signs_up, signups, created_at, expires_at FROM group_links WHERE code_hash = $1 AND ${ACTIVE}`,
      [inviteHash(code)],
    );
    return rows[0] ?? null;
  }

  /** Public. Never member names, never the room ID, never why a link does not work. */
  async preview(text: string) {
    const link = await this.active(text);
    if (!link || !this.deps.rooms) return { valid: false };
    const facts = await this.facts(link.room_id);
    if (!facts) return { valid: false };
    const inviter = link.created_by ? await inviterName(this.deps.db, link.created_by) : null;
    return {
      valid: true,
      ...(facts.name ? { name: facts.name } : {}),
      members: facts.joined.filter((u) => u !== this.deps.rooms!.userId).length,
      ...(inviter ? { inviter_name: inviter } : {}),
      signs_up: link.signs_up && link.signups < GROUP_LINK_MAX_SIGNUPS,
    };
  }

  /** The service account invites the caller. The app then joins the room. */
  async join(userId: string, text: string): Promise<{ room_id: string }> {
    const link = await this.active(text);
    if (!link) throw new ApiError("not_found");
    const rooms = this.rooms();
    const facts = await this.facts(link.room_id, true);
    if (!facts) throw new ApiError("not_found");
    if (facts.membership(userId) !== "join") {
      try {
        if (facts.membership(userId) !== "invite") await rooms.invite(link.room_id, userId);
      } catch (e) {
        if (e instanceof RoomRefused) throw new ApiError("group_link_no_access");
        throw e;
      }
      await recordJoin(this.deps.db, link.id, userId, false);
    }
    return { room_id: link.room_id };
  }

  /** After a sign-up with a group code: the new account gets the invite. Best effort; the app can call join again. */
  async inviteNewAccount(linkId: number, roomId: string, userId: string): Promise<boolean> {
    try {
      await this.rooms().invite(roomId, userId);
      await recordJoin(this.deps.db, String(linkId), userId, true);
      return true;
    } catch (e) {
      console.error(`group link: invite after sign-up failed (${(e as Error).message})`);
      return false;
    }
  }
}

async function recordJoin(db: Db, linkId: string, userId: string, signedUp: boolean): Promise<void> {
  await db.query(
    `INSERT INTO group_link_joins (link_id, user_id, signed_up) VALUES ($1, $2, $3)
     ON CONFLICT (link_id, user_id) DO UPDATE SET signed_up = group_link_joins.signed_up OR EXCLUDED.signed_up`,
    [linkId, userId, signedUp],
  );
}

/** The creator's public profile name, else the handle with @, else null. */
async function inviterName(db: Db, userId: string): Promise<string | null> {
  const { rows } = await db.query<{ handle: string | null; name: string | null }>(
    `SELECT h.handle, CASE WHEN p.enabled THEN p.name END AS name
     FROM (SELECT $1::text AS user_id) u LEFT JOIN handles h ON h.user_id = u.user_id LEFT JOIN public_profiles p ON p.user_id = u.user_id`,
    [userId],
  );
  const row = rows[0];
  return row?.name?.trim() || (row?.handle ? `@${row.handle}` : null);
}

/**
 * Takes one sign-up of a group link that signs people up (ADR 0184). null when the code is not such a link, or it
 * has no sign-ups left. In the sign-up's own order: after the invite check, before the account is made.
 */
export async function takeGroupSignup(db: Db | pg.PoolClient, text: string): Promise<{ linkId: number; roomId: string } | null> {
  const code = extractInviteCode(text);
  if (!code) return null;
  const { rows } = await db.query<{ id: string; room_id: string }>(
    `UPDATE group_links SET signups = signups + 1
     WHERE code_hash = $1 AND signs_up AND ${ACTIVE} AND signups < $2
     RETURNING id, room_id`,
    [inviteHash(code), GROUP_LINK_MAX_SIGNUPS],
  );
  return rows[0] ? { linkId: Number(rows[0].id), roomId: rows[0].room_id } : null;
}

export async function returnGroupSignup(db: Db, linkId: number): Promise<void> {
  await db.query("UPDATE group_links SET signups = signups - 1 WHERE id = $1 AND signups > 0", [linkId]);
}

/** Links and their joins go 365 days after the link expired or was revoked (bipe-shared product/data.json). */
export async function pruneGroupLinks(db: Db): Promise<number> {
  const { rowCount } = await db.query(
    "DELETE FROM group_links WHERE COALESCE(revoked_at, expires_at) < now() - interval '365 days'",
  );
  return rowCount ?? 0;
}
