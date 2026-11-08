// Who has each customer chat of a work account (ADR 0284 points 14 to 17, bipe#1292; contract /v1/me/business/chats).
// One row per customer room: the seat that has it, the status and times. No content, no customer text. A room with no
// row is open and in the pool. The record helps people divide work; it locks nothing in Matrix.
import type { ChatAssignment, ChatAssignmentList, ChatAssignmentUpdate } from "./generated/business-api.js";
import { inTransaction, lockBusiness, type Queryable } from "./business-common.js";
import { callerSeat, type SeatMas } from "./business-seats.js";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";

type Row = { room_id: string; assignee_seat_id: string | null; status: ChatAssignment["status"]; opened_at: Date; updated_at: Date };
type Deps = { db: Db; mas: SeatMas };

const view = (r: Row): ChatAssignment => ({
  room_id: r.room_id,
  assignee_seat_id: r.assignee_seat_id,
  status: r.status,
  opened_at: r.opened_at.toISOString(),
  updated_at: r.updated_at.toISOString(),
});

/** Every route needs a device that belongs to a person (ADR 0284): a device with no seat gets 403 seat_required. */
async function requireSeat(deps: Deps, businessId: string, deviceId: string | null): Promise<void> {
  if (!(await callerSeat(deps, businessId, deviceId))) throw new ApiError("seat_required");
}

/** GET /v1/me/business/chats. */
export async function listChats(deps: Deps, businessId: string, deviceId: string | null): Promise<ChatAssignmentList> {
  await requireSeat(deps, businessId, deviceId);
  const { rows } = await deps.db.query<Row>(
    "SELECT room_id, assignee_seat_id::text, status, opened_at, updated_at FROM business_chats WHERE business_id = $1 ORDER BY updated_at DESC",
    [businessId],
  );
  return { chats: rows.map(view) };
}

async function activeSeat(db: Queryable, businessId: string, seatId: string): Promise<void> {
  const { rowCount } = await db.query("SELECT 1 FROM business_seats WHERE business_id = $1 AND id::text = $2 AND status = 'active'", [businessId, seatId]);
  if (!rowCount) throw new ApiError("not_found", "seat");
}

/**
 * PUT /v1/me/business/chats/{roomId}. Take, give, put back or set the status. expected_assignee_seat_id is what the client
 * last saw: when another person changed the chat since, nothing changes and the answer is 409 chat_taken.
 */
export async function updateChat(deps: Deps, businessId: string, deviceId: string | null, roomId: string, body: ChatAssignmentUpdate): Promise<ChatAssignment> {
  await requireSeat(deps, businessId, deviceId);
  return inTransaction(deps.db, async (client) => {
    await lockBusiness(client, businessId);
    const { rows } = await client.query<Row>(
      "SELECT room_id, assignee_seat_id::text, status, opened_at, updated_at FROM business_chats WHERE business_id = $1 AND room_id = $2",
      [businessId, roomId],
    );
    const current = rows[0]?.assignee_seat_id ?? null;
    if (current !== body.expected_assignee_seat_id) throw new ApiError("chat_taken");
    if (body.assignee_seat_id !== null) await activeSeat(client, businessId, body.assignee_seat_id);
    const status = body.status ?? rows[0]?.status ?? "open";
    const { rows: out } = await client.query<Row>(
      `INSERT INTO business_chats (business_id, room_id, assignee_seat_id, status) VALUES ($1, $2, $3::uuid, $4)
       ON CONFLICT (business_id, room_id) DO UPDATE SET assignee_seat_id = $3::uuid, status = $4, updated_at = now()
       RETURNING room_id, assignee_seat_id::text, status, opened_at, updated_at`,
      [businessId, roomId, body.assignee_seat_id, status],
    );
    return view(out[0]!);
  });
}

/** The work account left a room: its record goes (from the bipe_messaging membership call). No-op for other accounts. */
export async function forgetChat(db: Queryable, userId: string, roomId: string): Promise<void> {
  await db.query("DELETE FROM business_chats WHERE business_id = $1 AND room_id = $2", [userId, roomId]);
}
