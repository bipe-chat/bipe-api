// Member identities of a work account (ADR 0284 phase B, bipe#1294; contract /v1/me/business/members*).
// Each person in Quem atende gets a Matrix user of its own for Interno: localpart memberLocalpartPrefix plus random
// base32, the seat name as display name, no handle. bipe_messaging (bipe-infra) keeps it inside the account. The API
// never stores a password: a session call sets a new one and returns it once. A seat that ends leaves its member
// identity to retireMembers(), which deactivates it and keeps the history for the others.
import { randomInt } from "node:crypto";
import type { WorkMemberSession, WorkMembers } from "./generated/business-api.js";
import { inTransaction, lockBusiness } from "./business-common.js";
import { callerSeat, type SeatMas } from "./business-seats.js";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { accountRules } from "./registry.js";
import { newSecret } from "./secrets.js";

/** The MAS admin calls member identities need. Mas implements it. */
export interface MemberMas extends SeatMas {
  createUser(username: string, displayname?: string): Promise<string | null>;
  setPassword(userId: string, password: string): Promise<boolean>;
  deactivate(userId: string): Promise<void>;
}
export type MemberDeps = { db: Db; mas: MemberMas; serverName: string; synapse: { deactivate(userId: string, erase?: boolean): Promise<void> } | null };

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const prefix = () => accountRules.memberLocalpartPrefix;
const localpartOf = (userId: string) => userId.slice(1).split(":")[0]!;

/** True for a member identity of this server, from its ID alone (the same rule as the Synapse fence). */
export function isMemberId(userId: string, serverName: string): boolean {
  return userId.startsWith(`@${prefix()}`) && userId.endsWith(`:${serverName}`);
}

async function seatOrRefuse(deps: MemberDeps, businessId: string, deviceId: string | null): Promise<{ id: string }> {
  const seat = await callerSeat(deps, businessId, deviceId);
  if (!seat) throw new ApiError("seat_required");
  return seat;
}

/** GET /v1/me/business/members. Only active seats; a seat with no member identity yet is left out. */
export async function listMembers(deps: MemberDeps, businessId: string, deviceId: string | null): Promise<WorkMembers> {
  const seat = await seatOrRefuse(deps, businessId, deviceId);
  const { rows } = await deps.db.query<{ seat_id: string; user_id: string; name: string }>(
    `SELECT m.seat_id::text, m.user_id, s.name FROM business_members m JOIN business_seats s ON s.id = m.seat_id
     WHERE m.business_id = $1 AND s.status = 'active' AND NOT m.retire ORDER BY s.role = 'owner' DESC, s.created_at`,
    [businessId],
  );
  const { rows: settings } = await deps.db.query<{ geral_room_id: string | null }>("SELECT geral_room_id FROM business_work_settings WHERE business_id = $1", [businessId]);
  return {
    members: rows.map((r) => ({ seat_id: r.seat_id, user_id: r.user_id, name: r.name })),
    me: rows.find((r) => r.seat_id === seat.id)?.user_id ?? null,
    geral_room_id: settings[0]?.geral_room_id ?? null,
  };
}

/** POST /v1/me/business/members/session: the seat's member identity, made on first use, and a new one-use password. */
export async function memberSession(deps: MemberDeps, businessId: string, deviceId: string | null): Promise<WorkMemberSession> {
  const seat = await seatOrRefuse(deps, businessId, deviceId);
  const { userId, masId } = await inTransaction(deps.db, async (client) => {
    await lockBusiness(client, businessId);
    const { rows } = await client.query<{ user_id: string }>("SELECT user_id FROM business_members WHERE seat_id = $1::uuid AND NOT retire", [seat.id]);
    if (rows[0]) {
      const user = await deps.mas.userByUsername(localpartOf(rows[0].user_id));
      if (!user) throw new ApiError("internal", "member_unavailable");
      return { userId: rows[0].user_id, masId: user.id };
    }
    const { rows: names } = await client.query<{ name: string }>("SELECT name FROM business_seats WHERE id = $1::uuid", [seat.id]);
    for (let i = 0; i < 5; i++) {
      const localpart = prefix() + Array.from({ length: 16 }, () => BASE32[randomInt(32)]).join("");
      const masId = await deps.mas.createUser(localpart, names[0]?.name);
      if (!masId) continue;
      const userId = `@${localpart}:${deps.serverName}`;
      await client.query("INSERT INTO business_members (seat_id, business_id, user_id) VALUES ($1::uuid, $2, $3)", [seat.id, businessId, userId]);
      return { userId, masId };
    }
    throw new ApiError("internal", "member_unavailable");
  });
  // Returned once, never stored and never logged.
  const password = newSecret();
  if (!(await deps.mas.setPassword(masId, password))) throw new ApiError("internal", "member_unavailable");
  return { user_id: userId, password };
}

/** PUT /v1/me/business/members/geral: the first claim wins. */
export async function claimGeral(deps: MemberDeps, businessId: string, deviceId: string | null, roomId: string): Promise<WorkMembers> {
  await seatOrRefuse(deps, businessId, deviceId);
  const { rows } = await deps.db.query<{ geral_room_id: string }>(
    `INSERT INTO business_work_settings (business_id, geral_room_id) VALUES ($1, $2)
     ON CONFLICT (business_id) DO UPDATE SET geral_room_id = COALESCE(business_work_settings.geral_room_id, EXCLUDED.geral_room_id)
     RETURNING geral_room_id`,
    [businessId, roomId],
  );
  if (rows[0]?.geral_room_id !== roomId) throw new ApiError("geral_exists");
  return listMembers(deps, businessId, deviceId);
}

/** may-invite between two member identities: only when both belong to one work account and are not retired. */
export async function sameAccount(db: Db, a: string, b: string): Promise<boolean> {
  const { rows } = await db.query<{ n: number; c: number }>(
    "SELECT count(DISTINCT business_id)::int AS n, count(*)::int AS c FROM business_members WHERE user_id = ANY($1::text[]) AND NOT retire",
    [[a, b]],
  );
  return a !== b && rows[0]?.c === 2 && rows[0]?.n === 1;
}

/**
 * Deactivates the member identities whose seat ended or whose account is going (deletion sets retire). MAS first, so
 * no new sign-in; then Synapse without erase, so the other people keep the history. A failure stays for the next run.
 */
export async function retireMembers(deps: MemberDeps): Promise<number> {
  const { rows } = await deps.db.query<{ seat_id: string; user_id: string }>(
    `SELECT m.seat_id::text, m.user_id FROM business_members m LEFT JOIN business_seats s ON s.id = m.seat_id
     WHERE m.retire OR s.id IS NULL LIMIT 50`,
  );
  let done = 0;
  for (const row of rows) {
    try {
      const user = await deps.mas.userByUsername(localpartOf(row.user_id));
      if (user) await deps.mas.deactivate(user.id);
      if (deps.synapse) await deps.synapse.deactivate(row.user_id, false);
      else continue;
      await deps.db.query("DELETE FROM business_members WHERE seat_id = $1::uuid", [row.seat_id]);
      done++;
    } catch (e) {
      console.error("members: retire failed (%s)", (e as Error).name);
    }
  }
  return done;
}
