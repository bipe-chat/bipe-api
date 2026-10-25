// Fila virtual (ADR 0107, bipe#333): walk-in customers join today's queue and wait anywhere. One queue per business
// per local day; it resets every day. No location and no free text. Places go 30 days after their day.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { businessTimeZone, customerOf, inTransaction, isCompany, lockBusiness, localParts, type Queryable } from "./business-common.js";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import type { Queue, QueuePlace, QueuePosition } from "./generated/business-api.js";

export const DEFAULT_NO_SHOW_MINUTES = 10;
export const RETENTION_DAYS = 30;
const MAX_PLACES_PER_DAY = 500;

const Id = z.string().min(1).max(128);
export const PolicyBody = z.object({ no_show_after_minutes: z.number().int().min(1).max(240) }).strict();
export const JoinBody = z.object({ service_id: Id.optional() }).strict();
export const OwnerPlaceBody = z
  .object({
    customer: z.union([
      z.object({ user_id: z.string().regex(/^@[^:\s]{1,255}:[^\s]{1,255}$/) }).strict(),
      z.object({ name: z.string().trim().min(1).max(120) }).strict(),
    ]),
    service_id: Id.optional(),
  })
  .strict();

type QueueRow = { id: string; business_id: string; day: string; time_zone: string; open: boolean };
type PlaceRow = {
  id: string; queue_id: string; business_id: string; customer_id: string | null; customer_name: string | null;
  source: "customer" | "owner"; service_id: string | null; status: QueuePlace["status"]; joined_at: Date; called_at: Date | null; served_at: Date | null;
};
const PLACE_COLUMNS = "id, queue_id, business_id, customer_id, customer_name, source, service_id, status, joined_at, called_at, served_at";

function placeJson(p: PlaceRow): QueuePlace {
  return {
    id: p.id,
    queue_id: p.queue_id,
    business_id: p.business_id,
    customer: customerOf(p) as QueuePlace["customer"],
    source: p.source,
    ...(p.service_id ? { service_id: p.service_id } : {}),
    status: p.status,
    joined_at: p.joined_at.toISOString(),
    ...(p.called_at ? { called_at: p.called_at.toISOString() } : {}),
    ...(p.served_at ? { served_at: p.served_at.toISOString() } : {}),
  };
}

async function noShowMinutes(db: Queryable, businessId: string): Promise<number> {
  const { rows } = await db.query<{ no_show_after_minutes: number }>("SELECT no_show_after_minutes FROM queue_settings WHERE business_id = $1", [businessId]);
  return rows[0]?.no_show_after_minutes ?? DEFAULT_NO_SHOW_MINUTES;
}

async function queueJson(db: Queryable, q: QueueRow): Promise<Queue> {
  return { id: q.id, business_id: q.business_id, date: q.day, time_zone: q.time_zone, open: q.open, policy: { no_show_after_minutes: await noShowMinutes(db, q.business_id) } };
}

/** Today's queue of the business, made closed on first use. */
async function today(db: Queryable, businessId: string): Promise<QueueRow> {
  const timeZone = await businessTimeZone(db, businessId);
  const day = localParts(timeZone, Date.now()).date;
  await db.query("INSERT INTO queues (id, business_id, day, time_zone, open) VALUES ($1, $2, $3, $4, false) ON CONFLICT (business_id, day) DO NOTHING", [
    randomUUID(), businessId, day, timeZone,
  ]);
  const { rows } = await db.query<QueueRow>("SELECT id, business_id, day::text AS day, time_zone, open FROM queues WHERE business_id = $1 AND day = $2", [businessId, day]);
  return rows[0]!;
}

/** A called place whose window passed is no-show. Runs before every read, so the job is not needed for correctness. */
async function expireCalls(db: Queryable, businessId: string): Promise<void> {
  await db.query(
    `UPDATE queue_places SET status = 'no_show' WHERE business_id = $1 AND status = 'called'
       AND called_at < now() - make_interval(mins => $2)`,
    [businessId, await noShowMinutes(db, businessId)],
  );
}

export async function ownerQueue(db: Queryable, businessId: string): Promise<Queue> {
  return queueJson(db, await today(db, businessId));
}

export async function setOpen(db: Queryable, businessId: string, open: boolean): Promise<Queue> {
  const q = await today(db, businessId);
  await db.query("UPDATE queues SET open = $2 WHERE id = $1", [q.id, open]);
  return queueJson(db, { ...q, open });
}

export async function setPolicy(db: Queryable, businessId: string, body: z.infer<typeof PolicyBody>): Promise<Queue> {
  await db.query(
    "INSERT INTO queue_settings (business_id, no_show_after_minutes) VALUES ($1, $2) ON CONFLICT (business_id) DO UPDATE SET no_show_after_minutes = EXCLUDED.no_show_after_minutes",
    [businessId, body.no_show_after_minutes],
  );
  return ownerQueue(db, businessId);
}

/** The only list with other customers in it: today's places, in order of arrival. */
export async function ownerPlaces(db: Queryable, businessId: string) {
  const q = await today(db, businessId);
  await expireCalls(db, businessId);
  const { rows } = await db.query<PlaceRow>(`SELECT ${PLACE_COLUMNS} FROM queue_places WHERE queue_id = $1 ORDER BY joined_at, id`, [q.id]);
  return { places: rows.map(placeJson) };
}

async function checkService(db: Queryable, businessId: string, serviceId: string | undefined): Promise<void> {
  if (!serviceId) return;
  const { rowCount } = await db.query("SELECT 1 FROM catalog_items WHERE business_id = $1 AND id = $2 AND kind = 'service' AND archived_at IS NULL", [businessId, serviceId]);
  if (!rowCount) throw new ApiError("bad_request", "unknown_service");
}

async function insertPlace(db: Queryable, q: QueueRow, customer: { user_id: string } | { name: string }, source: "customer" | "owner", serviceId?: string): Promise<PlaceRow> {
  const { rows: count } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM queue_places WHERE queue_id = $1", [q.id]);
  if (count[0]!.n >= MAX_PLACES_PER_DAY) throw new ApiError("rate_limited", "queue_full");
  if ("user_id" in customer) {
    const { rowCount } = await db.query("SELECT 1 FROM queue_places WHERE business_id = $1 AND customer_id = $2 AND status IN ('waiting', 'called')", [q.business_id, customer.user_id]);
    if (rowCount) throw new ApiError("already_in_queue");
  }
  const { rows } = await db.query<PlaceRow>(
    `INSERT INTO queue_places (id, queue_id, business_id, customer_id, customer_name, source, service_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'waiting') RETURNING ${PLACE_COLUMNS}`,
    [randomUUID(), q.id, q.business_id, "user_id" in customer ? customer.user_id : null, "name" in customer ? customer.name : null, source, serviceId ?? null],
  );
  return rows[0]!;
}

export async function addPlace(db: Db, businessId: string, body: z.infer<typeof OwnerPlaceBody>): Promise<QueuePlace> {
  return inTransaction(db, async (client) => {
    await lockBusiness(client, businessId);
    await checkService(client, businessId, body.service_id);
    return placeJson(await insertPlace(client, await today(client, businessId), body.customer, "owner", body.service_id));
  });
}

/** Calls the waiting place that arrived first. A booking due now goes first in the owner's own view (agenda tab). */
export async function callNext(db: Db, businessId: string): Promise<QueuePlace> {
  return inTransaction(db, async (client) => {
    await lockBusiness(client, businessId);
    const q = await today(client, businessId);
    const { rows } = await client.query<PlaceRow>(
      `UPDATE queue_places SET status = 'called', called_at = now()
       WHERE id = (SELECT id FROM queue_places WHERE queue_id = $1 AND status = 'waiting' ORDER BY joined_at, id LIMIT 1)
       RETURNING ${PLACE_COLUMNS}`,
      [q.id],
    );
    if (!rows[0]) throw new ApiError("not_found", "queue_empty");
    return placeJson(rows[0]);
  });
}

type PlaceAction = "served" | "no-show" | "recall";

export async function placeAction(db: Db, businessId: string, placeId: string, action: PlaceAction): Promise<QueuePlace> {
  return inTransaction(db, async (client) => {
    await expireCalls(client, businessId);
    const { rows } = await client.query<PlaceRow>(`SELECT ${PLACE_COLUMNS} FROM queue_places WHERE id = $1 AND business_id = $2 FOR UPDATE`, [placeId, businessId]);
    const place = rows[0];
    if (!place) throw new ApiError("not_found");
    const allowed: Record<PlaceAction, QueuePlace["status"][]> = { served: ["waiting", "called", "no_show"], "no-show": ["waiting", "called"], recall: ["called", "no_show"] };
    if (!allowed[action].includes(place.status)) throw new ApiError("place_not_active");
    if (action === "recall" && place.customer_id) {
      const { rowCount } = await client.query("SELECT 1 FROM queue_places WHERE business_id = $1 AND customer_id = $2 AND status IN ('waiting', 'called') AND id <> $3", [businessId, place.customer_id, place.id]);
      if (rowCount) throw new ApiError("already_in_queue");
    }
    const set = action === "served" ? "status = 'served', served_at = now()" : action === "no-show" ? "status = 'no_show'" : "status = 'called', called_at = now()";
    const { rows: updated } = await client.query<PlaceRow>(`UPDATE queue_places SET ${set} WHERE id = $1 RETURNING ${PLACE_COLUMNS}`, [place.id]);
    return placeJson(updated[0]!);
  });
}

// ---- Customer ----------------------------------------------------------------------------------------------------

export async function publicQueue(db: Queryable, businessId: string): Promise<Queue> {
  return ownerQueue(db, businessId);
}

/**
 * Position and a wait range. The minutes per person are today's average from call to served, else the service's
 * duration. With neither, no estimate: the app says it has none, never zero.
 */
async function position(db: Queryable, place: PlaceRow): Promise<QueuePosition> {
  if (place.status !== "waiting") return { place: placeJson(place), position: 0 };
  const { rows } = await db.query<{ ahead: number; avg: number | null; duration: number | null }>(
    `SELECT
       (SELECT count(*)::int FROM queue_places WHERE queue_id = $1 AND status = 'waiting' AND (joined_at, id) < ($2, $3)) AS ahead,
       (SELECT avg(extract(epoch FROM served_at - called_at) / 60)::float FROM queue_places
          WHERE queue_id = $1 AND status = 'served' AND called_at IS NOT NULL AND served_at > called_at) AS avg,
       (SELECT duration_minutes FROM catalog_items WHERE id = $4) AS duration`,
    [place.queue_id, place.joined_at, place.id, place.service_id],
  );
  const { ahead, avg, duration } = rows[0]!;
  const per = avg ?? duration;
  const result: QueuePosition = { place: placeJson(place), position: ahead + 1 };
  if (per && per > 0) {
    const minutes = (ahead + 1) * per;
    result.wait = { min_minutes: Math.max(0, Math.floor((minutes * 0.75) / 5) * 5), max_minutes: Math.ceil((minutes * 1.25) / 5) * 5 };
  }
  return result;
}

export async function join(db: Db, businessId: string, customerId: string, body: z.infer<typeof JoinBody>): Promise<QueuePosition> {
  if (customerId === businessId) throw new ApiError("bad_request", "own_business");
  return inTransaction(db, async (client) => {
    await lockBusiness(client, businessId);
    const q = await today(client, businessId);
    if (!q.open) throw new ApiError("queue_closed");
    await expireCalls(client, businessId);
    await checkService(client, businessId, body.service_id);
    return position(client, await insertPlace(client, q, { user_id: customerId }, "customer", body.service_id));
  });
}

export async function myPlace(db: Queryable, businessId: string, customerId: string): Promise<QueuePosition> {
  await expireCalls(db, businessId);
  const { rows } = await db.query<PlaceRow>(
    `SELECT ${PLACE_COLUMNS} FROM queue_places WHERE business_id = $1 AND customer_id = $2 AND status IN ('waiting', 'called')`,
    [businessId, customerId],
  );
  if (!rows[0]) throw new ApiError("not_found");
  return position(db, rows[0]);
}

export async function leave(db: Db, businessId: string, customerId: string, placeId: string): Promise<QueuePosition> {
  return inTransaction(db, async (client) => {
    const { rows } = await client.query<PlaceRow>(`SELECT ${PLACE_COLUMNS} FROM queue_places WHERE id = $1 AND business_id = $2 AND customer_id = $3 FOR UPDATE`, [placeId, businessId, customerId]);
    if (!rows[0]) throw new ApiError("not_found");
    if (!["waiting", "called"].includes(rows[0].status)) throw new ApiError("place_not_active");
    const { rows: updated } = await client.query<PlaceRow>(`UPDATE queue_places SET status = 'left' WHERE id = $1 RETURNING ${PLACE_COLUMNS}`, [placeId]);
    return { place: placeJson(updated[0]!), position: 0 };
  });
}

/** A person's active places across businesses, or a company's active places. */
export async function myPlaces(db: Queryable, userId: string) {
  const company = await isCompany(db, userId);
  const { rows } = await db.query<PlaceRow>(
    `SELECT ${PLACE_COLUMNS} FROM queue_places WHERE ${company ? "business_id" : "customer_id"} = $1 AND status IN ('waiting', 'called')
     ORDER BY joined_at, id LIMIT 500`,
    [userId],
  );
  const places: QueuePosition[] = [];
  for (const row of rows) places.push(await position(db, row));
  return { places };
}

/** The job: places of past days that are still active end as left; places 30 days after their day go. */
export async function queueHousekeeping(db: Db): Promise<{ pruned: number }> {
  await db.query(
    `UPDATE queue_places p SET status = 'left' FROM queues q
     WHERE p.queue_id = q.id AND p.status IN ('waiting', 'called') AND q.day < (now() AT TIME ZONE q.time_zone)::date`,
  );
  const pruned = await db.query(`DELETE FROM queues WHERE day < (now() AT TIME ZONE time_zone)::date - ${RETENTION_DAYS}`);
  return { pruned: pruned.rowCount ?? 0 };
}
