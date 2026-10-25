// Pedidos (ADR 0105, bipe#341): a signed-in customer orders fixed-price products from the catálogo. The server
// snapshots names and prices and adds the total. Address and notes stay in the encrypted chat. Bipe moves no money
// (ADR 0012): Pix charge cards (ADR 0080) are not built, so the charge route answers pix_charge_unavailable.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { customerOf, DEFAULT_TIME_ZONE, inTransaction, isCompany, localParts, lockBusiness, validTimeZone, type Customer, type Queryable } from "./business-common.js";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import type { Order, OrderLine, OrderPolicy } from "./generated/business-api.js";

export const RETENTION_DAYS = 730; // ADR 0105: the two years of ADR 0103.
const MAX_LINES = 50;
const MAX_QUANTITY = 999;

const Id = z.string().min(1).max(128);
const Lines = z.array(z.object({ item_id: Id, quantity: z.number().int().min(1).max(MAX_QUANTITY) }).strict()).min(1).max(MAX_LINES);
export const OrderBody = z.object({ lines: Lines, fulfilment: z.enum(["pickup", "delivery"]), payment: z.enum(["in_person", "pix"]) }).strict();
export const OwnerOrderBody = OrderBody.extend({
  customer: z.union([
    z.object({ user_id: z.string().regex(/^@[^:\s]{1,255}:[^\s]{1,255}$/) }).strict(),
    z.object({ name: z.string().trim().min(1).max(120) }).strict(),
  ]),
}).strict();
export const PolicyBody = z
  .object({
    time_zone: z.string().max(64),
    weekdays: z.array(z.number().int().min(1).max(7)).max(7),
    cutoff: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
  })
  .strict();
export const RefusalBody = z.object({ reason: z.enum(["unavailable", "closed", "cannot_deliver", "cannot_fulfil"]) }).strict();

type OrderRow = {
  id: string; business_id: string; customer_id: string | null; customer_name: string | null; source: "customer" | "owner";
  lines: OrderLine[]; total_amount_cents: string; fulfilment: Order["fulfilment"]; payment: Order["payment"]; status: Order["status"];
  refuse_reason: Order["refuse_reason"] | null; quote_id: string | null; created_at: Date;
};
const COLUMNS = "id, business_id, customer_id, customer_name, source, lines, total_amount_cents, fulfilment, payment, status, refuse_reason, quote_id, created_at";

export function orderJson(o: OrderRow): Order {
  return {
    id: o.id,
    business_id: o.business_id,
    customer: customerOf(o) as Order["customer"],
    source: o.source,
    created_at: o.created_at.toISOString(),
    lines: o.lines,
    total_amount_cents: Number(o.total_amount_cents),
    currency: "BRL",
    fulfilment: o.fulfilment,
    payment: o.payment,
    status: o.status,
    ...(o.refuse_reason ? { refuse_reason: o.refuse_reason } : {}),
    ...(o.quote_id ? { quote_id: o.quote_id } : {}),
  };
}

/** Default: every day until 23:59 in the business time zone. */
export async function policyOf(db: Queryable, businessId: string): Promise<OrderPolicy> {
  const { rows } = await db.query<OrderPolicy>("SELECT time_zone, weekdays, cutoff FROM order_settings WHERE business_id = $1", [businessId]);
  if (rows[0]) return rows[0];
  const { rows: agenda } = await db.query<{ time_zone: string }>("SELECT time_zone FROM agenda_settings WHERE business_id = $1", [businessId]);
  return { time_zone: agenda[0]?.time_zone ?? DEFAULT_TIME_ZONE, weekdays: [1, 2, 3, 4, 5, 6, 7], cutoff: "23:59" };
}

export async function setPolicy(db: Queryable, businessId: string, body: z.infer<typeof PolicyBody>): Promise<OrderPolicy> {
  if (!validTimeZone(body.time_zone)) throw new ApiError("bad_request", "time_zone");
  const weekdays = [...new Set(body.weekdays)].sort();
  await db.query(
    `INSERT INTO order_settings (business_id, time_zone, weekdays, cutoff) VALUES ($1, $2, $3, $4)
     ON CONFLICT (business_id) DO UPDATE SET time_zone = EXCLUDED.time_zone, weekdays = EXCLUDED.weekdays, cutoff = EXCLUDED.cutoff`,
    [businessId, body.time_zone, weekdays, body.cutoff],
  );
  return { time_zone: body.time_zone, weekdays, cutoff: body.cutoff };
}

async function checkOpen(db: Queryable, businessId: string): Promise<void> {
  const policy = await policyOf(db, businessId);
  const now = localParts(policy.time_zone, Date.now());
  const cutoff = Number(policy.cutoff.slice(0, 2)) * 60 + Number(policy.cutoff.slice(3));
  if (!policy.weekdays.includes(now.weekday) || now.minute >= cutoff) throw new ApiError("orders_closed");
}

/** Snapshot lines from active fixed-price products of this business. Repeated items add up. */
async function snapshot(db: Queryable, businessId: string, lines: z.infer<typeof Lines>): Promise<{ lines: OrderLine[]; total: number }> {
  const quantities = new Map<string, number>();
  for (const line of lines) quantities.set(line.item_id, (quantities.get(line.item_id) ?? 0) + line.quantity);
  const { rows } = await db.query<{ id: string; kind: string; name: string; price: { mode: string; amount_cents?: number }; active: boolean; sold_out: boolean }>(
    `SELECT id, kind, name, price, active, sold_out_on = (now() AT TIME ZONE coalesce((SELECT time_zone FROM agenda_settings WHERE business_id = $1), $3))::date AS sold_out
     FROM catalog_items WHERE business_id = $1 AND id = ANY($2) AND archived_at IS NULL`,
    [businessId, [...quantities.keys()], DEFAULT_TIME_ZONE],
  );
  const out: OrderLine[] = [];
  let total = 0;
  for (const [itemId, quantity] of quantities) {
    const item = rows.find((r) => r.id === itemId);
    if (!item || !item.active || item.sold_out || item.kind !== "product" || quantity > MAX_QUANTITY) throw new ApiError("item_unavailable", itemId);
    if (item.price.mode !== "fixed" || typeof item.price.amount_cents !== "number") throw new ApiError("price_not_fixed", itemId);
    const lineTotal = item.price.amount_cents * quantity;
    out.push({ item_id: itemId, name: item.name, quantity, unit_amount_cents: item.price.amount_cents, total_amount_cents: lineTotal });
    total += lineTotal;
  }
  return { lines: out, total };
}

/** Pix needs a verified CNPJ (ADR 0080); even then no charge flow exists yet. */
async function checkPayment(db: Queryable, businessId: string, payment: Order["payment"]): Promise<void> {
  if (payment !== "pix") return;
  const { rows } = await db.query<{ status: string }>("SELECT status FROM business_claims WHERE user_id = $1", [businessId]);
  if (rows[0]?.status !== "verified") throw new ApiError("payment_requires_verified_business");
  throw new ApiError("pix_charge_unavailable");
}

export async function insertOrder(
  client: pg.PoolClient,
  o: { businessId: string; customer: Customer; source: "customer" | "owner"; lines: OrderLine[]; total: number; fulfilment: Order["fulfilment"]; payment: Order["payment"]; quoteId?: string },
): Promise<Order> {
  if ("user_id" in o.customer) {
    const { rowCount } = await client.query("SELECT 1 FROM orders WHERE business_id = $1 AND customer_id = $2 AND status IN ('sent', 'accepted', 'ready')", [o.businessId, o.customer.user_id]);
    if (rowCount) throw new ApiError("order_already_open");
  }
  const { rows } = await client.query<OrderRow>(
    `INSERT INTO orders (id, business_id, customer_id, customer_name, source, lines, total_amount_cents, fulfilment, payment, status, quote_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${COLUMNS}`,
    [
      randomUUID(), o.businessId, "user_id" in o.customer ? o.customer.user_id : null, "name" in o.customer ? o.customer.name : null, o.source,
      JSON.stringify(o.lines), o.total, o.fulfilment, o.payment, o.source === "owner" ? "accepted" : "sent", o.quoteId ?? null,
    ],
  );
  return orderJson(rows[0]!);
}

export async function placeOrder(db: Db, businessId: string, customerId: string, body: z.infer<typeof OrderBody>): Promise<Order> {
  if (customerId === businessId) throw new ApiError("bad_request", "own_business");
  return inTransaction(db, async (client) => {
    await lockBusiness(client, businessId);
    await checkOpen(client, businessId);
    const { lines, total } = await snapshot(client, businessId, body.lines);
    await checkPayment(client, businessId, body.payment);
    return insertOrder(client, { businessId, customer: { user_id: customerId }, source: "customer", lines, total, fulfilment: body.fulfilment, payment: body.payment });
  });
}

/** An order the owner types in, accepted at once. Prices and the open-order rule still apply. */
export async function ownerOrder(db: Db, businessId: string, body: z.infer<typeof OwnerOrderBody>): Promise<Order> {
  return inTransaction(db, async (client) => {
    await lockBusiness(client, businessId);
    const { lines, total } = await snapshot(client, businessId, body.lines);
    await checkPayment(client, businessId, body.payment);
    return insertOrder(client, { businessId, customer: body.customer, source: "owner", lines, total, fulfilment: body.fulfilment, payment: body.payment });
  });
}

export async function ownerOrders(db: Queryable, businessId: string) {
  const { rows } = await db.query<OrderRow>(`SELECT ${COLUMNS} FROM orders WHERE business_id = $1 ORDER BY created_at DESC, id LIMIT 300`, [businessId]);
  return { orders: rows.map(orderJson) };
}

async function row(db: Queryable, where: string, params: unknown[]): Promise<OrderRow> {
  const { rows } = await db.query<OrderRow>(`SELECT ${COLUMNS} FROM orders WHERE ${where} FOR UPDATE`, params);
  if (!rows[0]) throw new ApiError("not_found");
  return rows[0];
}

export async function ownerGet(db: Queryable, businessId: string, orderId: string): Promise<Order> {
  const { rows } = await db.query<OrderRow>(`SELECT ${COLUMNS} FROM orders WHERE id = $1 AND business_id = $2`, [orderId, businessId]);
  if (!rows[0]) throw new ApiError("not_found");
  return orderJson(rows[0]);
}

const TRANSITIONS: Record<"accept" | "refuse" | "ready" | "done" | "cancel", { from: Order["status"][]; to: Order["status"] }> = {
  accept: { from: ["sent"], to: "accepted" },
  refuse: { from: ["sent"], to: "refused" },
  ready: { from: ["accepted"], to: "ready" },
  done: { from: ["ready"], to: "done" },
  cancel: { from: ["sent", "accepted", "ready"], to: "cancelled" },
};

export async function ownerTransition(db: Db, businessId: string, orderId: string, action: keyof typeof TRANSITIONS, reason?: Order["refuse_reason"]): Promise<Order> {
  return inTransaction(db, async (client) => {
    const order = await row(client, "id = $1 AND business_id = $2", [orderId, businessId]);
    const t = TRANSITIONS[action];
    if (order.status === t.to) return orderJson(order);
    if (!t.from.includes(order.status)) throw new ApiError("order_not_open", order.status);
    const { rows } = await client.query<OrderRow>(`UPDATE orders SET status = $2, refuse_reason = $3, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`, [
      order.id, t.to, action === "refuse" ? reason ?? null : order.refuse_reason,
    ]);
    return orderJson(rows[0]!);
  });
}

export async function customerGet(db: Queryable, businessId: string, customerId: string, orderId: string): Promise<Order> {
  const { rows } = await db.query<OrderRow>(`SELECT ${COLUMNS} FROM orders WHERE id = $1 AND business_id = $2 AND customer_id = $3`, [orderId, businessId, customerId]);
  if (!rows[0]) throw new ApiError("not_found");
  return orderJson(rows[0]);
}

export async function customerCancel(db: Db, businessId: string, customerId: string, orderId: string): Promise<Order> {
  return inTransaction(db, async (client) => {
    const order = await row(client, "id = $1 AND business_id = $2 AND customer_id = $3", [orderId, businessId, customerId]);
    if (order.status === "cancelled") return orderJson(order);
    if (!TRANSITIONS.cancel.from.includes(order.status)) throw new ApiError("order_not_open", order.status);
    const { rows } = await client.query<OrderRow>(`UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`, [order.id]);
    return orderJson(rows[0]!);
  });
}

/** A person's orders, or a company's: open ones and the last 30 days, newest first. */
export async function myOrders(db: Queryable, userId: string) {
  const company = await isCompany(db, userId);
  const { rows } = await db.query<OrderRow>(
    `SELECT ${COLUMNS} FROM orders WHERE ${company ? "business_id" : "customer_id"} = $1
       AND (status IN ('sent', 'accepted', 'ready') OR updated_at > now() - interval '30 days')
     ORDER BY created_at DESC, id LIMIT 300`,
    [userId],
  );
  return { orders: rows.map(orderJson) };
}

export async function orderHousekeeping(db: Db): Promise<{ pruned: number }> {
  const pruned = await db.query(`DELETE FROM orders WHERE created_at < now() - interval '${RETENTION_DAYS} days'`);
  return { pruned: pruned.rowCount ?? 0 };
}
