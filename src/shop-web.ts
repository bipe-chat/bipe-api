// The shop on the web (ADR 0195, bipe#804; contract: bipe-shared api/openapi.yaml). A person with no account books and
// orders with a first name. One random token per browser per shop is the only key to the records; the server keeps
// its SHA-256 and returns the token once. A signed-in person claims the records, and the token then stops working.
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import * as agenda from "./agenda.js";
import { inTransaction, lockBusiness, type Queryable } from "./business-common.js";
import * as tools from "./business-tools.js";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import type { WebBookingResult, WebOrderResult, WebQueueResult, WebRecords } from "./generated/business-api.js";
import * as orders from "./orders.js";
import * as queue from "./queue.js";

export const TOKEN_HEADER = "x-bipe-shop-token";
export const ClaimBody = z.object({ token: z.string().min(1).max(128) }).strict();

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

/** The hash of a live token of this shop. Anything else is shop_token_invalid and says nothing more. */
async function requireToken(db: Queryable, businessId: string, token: string | undefined): Promise<string> {
  if (!token || token.length > 128) throw new ApiError("shop_token_invalid");
  const hash = hashOf(token);
  const { rows } = await db.query("SELECT 1 FROM shop_tokens WHERE token_hash = $1 AND business_id = $2 AND claimed_at IS NULL", [hash, businessId]);
  if (rows.length === 0) throw new ApiError("shop_token_invalid");
  return hash;
}

/** The first web action makes the token; a later one must bring a live token. */
async function tokenOrNew(db: Queryable, businessId: string, token: string | undefined): Promise<{ hash: string; fresh?: string }> {
  if (token) return { hash: await requireToken(db, businessId, token) };
  const fresh = randomBytes(32).toString("base64url");
  const hash = hashOf(fresh);
  await db.query("INSERT INTO shop_tokens (token_hash, business_id) VALUES ($1, $2)", [hash, businessId]);
  return { hash, fresh };
}

export async function book(db: Db, businessId: string, token: string | undefined, body: z.infer<typeof agenda.WebBookingBody>): Promise<WebBookingResult> {
  await tools.requireLive(db, businessId, "agenda");
  if (!(await tools.webSettings(db, businessId)).web_booking) throw new ApiError("web_off");
  return inTransaction(db, async (client) => {
    await lockBusiness(client, businessId);
    const { hash, fresh } = await tokenOrNew(client, businessId, token);
    const booking = await agenda.webBook(client, businessId, hash, body);
    return { ...(fresh ? { token: fresh } : {}), booking };
  });
}

export async function order(db: Db, businessId: string, token: string | undefined, body: z.infer<typeof orders.WebOrderBody>): Promise<WebOrderResult> {
  await tools.requireLive(db, businessId, "orders");
  if (!(await tools.webSettings(db, businessId)).web_orders) throw new ApiError("web_off");
  return inTransaction(db, async (client) => {
    await lockBusiness(client, businessId);
    const { hash, fresh } = await tokenOrNew(client, businessId, token);
    const made = await orders.webOrder(client, businessId, hash, body);
    return { ...(fresh ? { token: fresh } : {}), order: made };
  });
}

export async function joinQueue(db: Db, businessId: string, token: string | undefined, body: z.infer<typeof queue.WebJoinBody>): Promise<WebQueueResult> {
  await tools.requireLive(db, businessId, "queue");
  if (!(await tools.webSettings(db, businessId)).web_queue) throw new ApiError("web_off");
  return inTransaction(db, async (client) => {
    await lockBusiness(client, businessId);
    const { hash, fresh } = await tokenOrNew(client, businessId, token);
    const position = await queue.webJoin(client, businessId, hash, body);
    return { ...(fresh ? { token: fresh } : {}), position };
  });
}

export async function leaveQueue(db: Db, businessId: string, token: string | undefined, placeId: string) {
  return queue.webLeave(db, businessId, await requireToken(db, businessId, token), placeId);
}

async function recordsOf(db: Queryable, businessId: string, hash: string): Promise<WebRecords> {
  const [bookings, list, place] = await Promise.all([
    agenda.webBookings(db, businessId, hash),
    orders.webOrders(db, businessId, hash),
    queue.webPlace(db, businessId, hash),
  ]);
  return { bookings, orders: list, ...(place ? { queue_place: place } : {}) };
}

export async function records(db: Db, businessId: string, token: string | undefined): Promise<WebRecords> {
  return recordsOf(db, businessId, await requireToken(db, businessId, token));
}

export async function cancelBooking(db: Db, businessId: string, token: string | undefined, bookingId: string) {
  return agenda.webCancel(db, businessId, await requireToken(db, businessId, token), bookingId);
}

export async function cancelOrder(db: Db, businessId: string, token: string | undefined, orderId: string) {
  return orders.webCancel(db, businessId, await requireToken(db, businessId, token), orderId);
}

/** The token's records move to the account. They then get cards and pushes (ADR 0102). */
export async function claim(db: Db, businessId: string, token: string, userId: string): Promise<WebRecords> {
  if (userId === businessId) throw new ApiError("bad_request", "own_business");
  return inTransaction(db, async (client) => {
    await lockBusiness(client, businessId);
    const hash = await requireToken(client, businessId, token);
    await agenda.claimWebBookings(client, businessId, hash, userId);
    await orders.claimWebOrders(client, businessId, hash, userId);
    await queue.claimWebPlaces(client, businessId, hash, userId);
    await client.query("UPDATE shop_tokens SET claimed_at = now() WHERE token_hash = $1", [hash]);
    const [bookings, mine] = await Promise.all([agenda.myBookings(client, userId), orders.myOrders(client, userId)]);
    return {
      bookings: bookings.bookings.filter((b) => b.business_id === businessId),
      orders: mine.orders.filter((o) => o.business_id === businessId),
    };
  });
}
