// Orçamento (ADR 0106, bipe#337): the customer asks; the business answers with a quote card. The request holds only
// business, customer and time; the description and photos stay in the encrypted chat. Quote lines are business
// text. A new version replaces the old one, which stays readable. Accepting turns the quote into a booking or an
// order in the same transaction, so a retry cannot make a second one.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { bookInTransaction } from "./agenda.js";
import { inTransaction, isCompany, lockBusiness, type Queryable } from "./business-common.js";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import type { Quote, QuoteLine, QuoteRequest, QuoteVersion } from "./generated/business-api.js";
import { insertOrder } from "./orders.js";

export const RETENTION_DAYS = 730; // ADR 0106: the two years of ADR 0103.
const MAX_OPEN_REQUESTS = 3;

const Id = z.string().min(1).max(128);
const Amount = z.number().int().min(0).max(1_000_000_000);
const Quantity = z.number().positive().max(100_000);
export const VersionBody = z
  .object({
    lines: z
      .array(z.union([
        z.object({ item_id: Id, quantity: Quantity, unit_amount_cents: Amount }).strict(),
        z.object({ name: z.string().trim().min(1).max(200), quantity: Quantity, unit_amount_cents: Amount }).strict(),
      ]))
      .min(1)
      .max(50),
    valid_until: z.iso.datetime().refine((v) => v.endsWith("Z"), "utc"),
    visit_service_id: Id.optional(),
  })
  .strict();
const Instant = z.iso.datetime().refine((v) => v.endsWith("Z"), "utc");
export const AcceptBody = z.union([
  z.object({ version: z.number().int().min(1), target: z.literal("booking"), booking: z.object({ service_id: Id, agenda_id: Id, start: Instant }).strict() }).strict(),
  z.object({ version: z.number().int().min(1), target: z.literal("order"), fulfilment: z.enum(["pickup", "delivery"]), payment: z.enum(["in_person", "pix"]) }).strict(),
]);
export const DeclineBody = z.object({ version: z.number().int().min(1) }).strict();

type RequestRow = { id: string; business_id: string; customer_id: string; created_at: Date };
type QuoteRow = { id: string; request_id: string; business_id: string; customer_id: string; status: "offered" | "accepted" | "refused"; current_version: number; booking_id: string | null; order_id: string | null };
type VersionRow = { quote_id: string; version: number; created_at: Date; valid_until: Date; lines: QuoteLine[]; total_amount_cents: string; visit_service_id: string | null };
const QUOTE_COLUMNS = "id, request_id, business_id, customer_id, status, current_version, booking_id, order_id";

const requestJson = (r: RequestRow): QuoteRequest => ({ id: r.id, business_id: r.business_id, customer_id: r.customer_id, created_at: r.created_at.toISOString() });
const versionJson = (v: VersionRow): QuoteVersion => ({
  version: v.version,
  created_at: v.created_at.toISOString(),
  valid_until: v.valid_until.toISOString(),
  lines: v.lines,
  total_amount_cents: Number(v.total_amount_cents),
  currency: "BRL",
  ...(v.visit_service_id ? { visit_service_id: v.visit_service_id } : {}),
});

async function quotesJson(db: Queryable, rows: QuoteRow[]): Promise<Quote[]> {
  if (!rows.length) return [];
  const { rows: versions } = await db.query<VersionRow>(
    "SELECT quote_id, version, created_at, valid_until, lines, total_amount_cents, visit_service_id FROM quote_versions WHERE quote_id = ANY($1) ORDER BY version",
    [rows.map((r) => r.id)],
  );
  const now = Date.now();
  return rows.map((q) => {
    const mine = versions.filter((v) => v.quote_id === q.id);
    const current = mine.find((v) => v.version === q.current_version);
    const expired = q.status === "offered" && !!current && current.valid_until.getTime() <= now;
    return {
      id: q.id,
      request_id: q.request_id,
      business_id: q.business_id,
      customer_id: q.customer_id,
      status: expired ? "expired" : q.status,
      current_version: q.current_version,
      versions: mine.map(versionJson),
      ...(q.booking_id ? { booking_id: q.booking_id } : {}),
      ...(q.order_id ? { order_id: q.order_id } : {}),
    };
  });
}

async function quoteJson(db: Queryable, q: QuoteRow): Promise<Quote> {
  return (await quotesJson(db, [q]))[0]!;
}

// ---- Customer request ----------------------------------------------------------------------------------------------

/** One unanswered request per customer and business: a second tap returns the first. */
export async function request(db: Db, businessId: string, customerId: string): Promise<QuoteRequest> {
  if (customerId === businessId) throw new ApiError("bad_request", "own_business");
  return inTransaction(db, async (client) => {
    await lockBusiness(client, businessId);
    const { rows: open } = await client.query<RequestRow>(
      `SELECT r.id, r.business_id, r.customer_id, r.created_at FROM quote_requests r LEFT JOIN quotes q ON q.request_id = r.id
       WHERE r.business_id = $1 AND r.customer_id = $2 AND q.id IS NULL ORDER BY r.created_at`,
      [businessId, customerId],
    );
    if (open[0]) return requestJson(open[0]);
    const { rows: offered } = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM quotes WHERE business_id = $1 AND customer_id = $2 AND status = 'offered'", [businessId, customerId]);
    if (offered[0]!.n >= MAX_OPEN_REQUESTS) throw new ApiError("rate_limited", "open_quotes");
    const { rows } = await client.query<RequestRow>(
      "INSERT INTO quote_requests (id, business_id, customer_id) VALUES ($1, $2, $3) RETURNING id, business_id, customer_id, created_at",
      [randomUUID(), businessId, customerId],
    );
    return requestJson(rows[0]!);
  });
}

// ---- Owner -------------------------------------------------------------------------------------------------------------

/** Requests with no quote yet, newest first. */
export async function ownerRequests(db: Queryable, businessId: string) {
  const { rows } = await db.query<RequestRow>(
    `SELECT r.id, r.business_id, r.customer_id, r.created_at FROM quote_requests r LEFT JOIN quotes q ON q.request_id = r.id
     WHERE r.business_id = $1 AND q.id IS NULL AND r.created_at > now() - interval '${RETENTION_DAYS} days' ORDER BY r.created_at DESC LIMIT 300`,
    [businessId],
  );
  return { requests: rows.map(requestJson) };
}

/** Lines get their name from the catálogo when they name an item; amounts are added up here, never trusted. */
async function buildVersion(db: Queryable, businessId: string, body: z.infer<typeof VersionBody>) {
  if (Date.parse(body.valid_until) <= Date.now()) throw new ApiError("bad_request", "valid_until");
  const ids = body.lines.flatMap((l) => ("item_id" in l ? [l.item_id] : []));
  const { rows: items } = await db.query<{ id: string; name: string }>("SELECT id, name FROM catalog_items WHERE business_id = $1 AND id = ANY($2) AND archived_at IS NULL", [businessId, ids]);
  if (body.visit_service_id) {
    const { rowCount } = await db.query("SELECT 1 FROM catalog_items WHERE business_id = $1 AND id = $2 AND kind = 'service' AND archived_at IS NULL", [businessId, body.visit_service_id]);
    if (!rowCount) throw new ApiError("bad_request", "visit_service_id");
  }
  let total = 0;
  const lines: QuoteLine[] = body.lines.map((l) => {
    const name = "item_id" in l ? items.find((i) => i.id === l.item_id)?.name : l.name;
    if (!name) throw new ApiError("bad_request", "unknown_item");
    const lineTotal = Math.round(l.quantity * l.unit_amount_cents);
    total += lineTotal;
    return { ...("item_id" in l ? { item_id: l.item_id } : {}), name, quantity: l.quantity, unit_amount_cents: l.unit_amount_cents, total_amount_cents: lineTotal };
  });
  return { lines, total };
}

export async function answer(db: Db, businessId: string, requestId: string, body: z.infer<typeof VersionBody>): Promise<Quote> {
  return inTransaction(db, async (client) => {
    await lockBusiness(client, businessId);
    const { rows } = await client.query<RequestRow>("SELECT id, business_id, customer_id, created_at FROM quote_requests WHERE id = $1 AND business_id = $2", [requestId, businessId]);
    const req = rows[0];
    if (!req) throw new ApiError("not_found");
    const { rowCount } = await client.query("SELECT 1 FROM quotes WHERE request_id = $1", [requestId]);
    if (rowCount) throw new ApiError("quote_not_open", "already_answered");
    const { lines, total } = await buildVersion(client, businessId, body);
    const id = randomUUID();
    await client.query("INSERT INTO quotes (id, request_id, business_id, customer_id, status, current_version) VALUES ($1, $2, $3, $4, 'offered', 1)", [id, requestId, businessId, req.customer_id]);
    await client.query("INSERT INTO quote_versions (quote_id, version, valid_until, lines, total_amount_cents, visit_service_id) VALUES ($1, 1, $2, $3, $4, $5)", [
      id, body.valid_until, JSON.stringify(lines), total, body.visit_service_id ?? null,
    ]);
    return quoteJson(client, (await client.query<QuoteRow>(`SELECT ${QUOTE_COLUMNS} FROM quotes WHERE id = $1`, [id])).rows[0]!);
  });
}

export async function ownerQuotes(db: Queryable, businessId: string) {
  const { rows } = await db.query<QuoteRow>(`SELECT ${QUOTE_COLUMNS} FROM quotes WHERE business_id = $1 ORDER BY updated_at DESC, id LIMIT 300`, [businessId]);
  return { quotes: await quotesJson(db, rows) };
}

async function quoteRow(db: Queryable, where: string, params: unknown[], lock = false): Promise<QuoteRow> {
  const { rows } = await db.query<QuoteRow>(`SELECT ${QUOTE_COLUMNS} FROM quotes WHERE ${where}${lock ? " FOR UPDATE" : ""}`, params);
  if (!rows[0]) throw new ApiError("not_found");
  return rows[0];
}

export async function ownerQuote(db: Queryable, businessId: string, quoteId: string): Promise<Quote> {
  return quoteJson(db, await quoteRow(db, "id = $1 AND business_id = $2", [quoteId, businessId]));
}

/** A new version of an offered quote (an expired one too: the new version opens it again). */
export async function revise(db: Db, businessId: string, quoteId: string, body: z.infer<typeof VersionBody>): Promise<Quote> {
  return inTransaction(db, async (client) => {
    const quote = await quoteRow(client, "id = $1 AND business_id = $2", [quoteId, businessId], true);
    if (quote.status !== "offered") throw new ApiError("quote_not_open", quote.status);
    const { lines, total } = await buildVersion(client, businessId, body);
    const version = quote.current_version + 1;
    await client.query("INSERT INTO quote_versions (quote_id, version, valid_until, lines, total_amount_cents, visit_service_id) VALUES ($1, $2, $3, $4, $5, $6)", [
      quote.id, version, body.valid_until, JSON.stringify(lines), total, body.visit_service_id ?? null,
    ]);
    await client.query("UPDATE quotes SET current_version = $2, updated_at = now() WHERE id = $1", [quote.id, version]);
    return quoteJson(client, { ...quote, current_version: version });
  });
}

// ---- Customer decision -------------------------------------------------------------------------------------------------

export async function customerQuote(db: Queryable, businessId: string, customerId: string, quoteId: string): Promise<Quote> {
  return quoteJson(db, await quoteRow(db, "id = $1 AND business_id = $2 AND customer_id = $3", [quoteId, businessId, customerId]));
}

async function openCurrent(db: Queryable, quote: QuoteRow, version: number): Promise<VersionRow> {
  if (quote.status !== "offered") throw new ApiError("quote_not_open", quote.status);
  if (version !== quote.current_version) throw new ApiError("quote_version_changed");
  const { rows } = await db.query<VersionRow>(
    "SELECT quote_id, version, created_at, valid_until, lines, total_amount_cents, visit_service_id FROM quote_versions WHERE quote_id = $1 AND version = $2",
    [quote.id, version],
  );
  const current = rows[0]!;
  if (current.valid_until.getTime() <= Date.now()) throw new ApiError("quote_expired");
  return current;
}

export async function accept(db: Db, businessId: string, customerId: string, quoteId: string, body: z.infer<typeof AcceptBody>): Promise<Quote> {
  return inTransaction(db, async (client) => {
    await lockBusiness(client, businessId);
    const quote = await quoteRow(client, "id = $1 AND business_id = $2 AND customer_id = $3", [quoteId, businessId, customerId], true);
    if (quote.status === "accepted" && body.version === quote.current_version) return quoteJson(client, quote);
    const current = await openCurrent(client, quote, body.version);
    let bookingId: string | null = null;
    let orderId: string | null = null;
    if (body.target === "booking") {
      bookingId = (await bookInTransaction(client, businessId, customerId, body.booking)).id;
    } else {
      if (body.payment === "pix") {
        const { rows } = await client.query<{ status: string }>("SELECT status FROM business_claims WHERE user_id = $1", [businessId]);
        throw new ApiError(rows[0]?.status === "verified" ? "pix_charge_unavailable" : "payment_requires_verified_business");
      }
      const order = await insertOrder(client, {
        businessId, customer: { user_id: customerId }, source: "customer", lines: current.lines, total: Number(current.total_amount_cents),
        fulfilment: body.fulfilment, payment: body.payment, quoteId: quote.id,
      });
      orderId = order.id;
    }
    const { rows } = await client.query<QuoteRow>(
      `UPDATE quotes SET status = 'accepted', booking_id = $2, order_id = $3, updated_at = now() WHERE id = $1 RETURNING ${QUOTE_COLUMNS}`,
      [quote.id, bookingId, orderId],
    );
    return quoteJson(client, rows[0]!);
  });
}

export async function refuse(db: Db, businessId: string, customerId: string, quoteId: string, body: z.infer<typeof DeclineBody>): Promise<Quote> {
  return inTransaction(db, async (client) => {
    const quote = await quoteRow(client, "id = $1 AND business_id = $2 AND customer_id = $3", [quoteId, businessId, customerId], true);
    if (quote.status === "refused") return quoteJson(client, quote);
    if (quote.status !== "offered") throw new ApiError("quote_not_open", quote.status);
    if (body.version !== quote.current_version) throw new ApiError("quote_version_changed");
    const { rows } = await client.query<QuoteRow>(`UPDATE quotes SET status = 'refused', updated_at = now() WHERE id = $1 RETURNING ${QUOTE_COLUMNS}`, [quote.id]);
    return quoteJson(client, rows[0]!);
  });
}

/** A person's quotes, or a company's: open ones and those changed in the last 30 days. */
export async function myQuotes(db: Queryable, userId: string) {
  const company = await isCompany(db, userId);
  const { rows } = await db.query<QuoteRow>(
    `SELECT ${QUOTE_COLUMNS} FROM quotes WHERE ${company ? "business_id" : "customer_id"} = $1
       AND (status = 'offered' OR updated_at > now() - interval '30 days')
     ORDER BY updated_at DESC, id LIMIT 300`,
    [userId],
  );
  return { quotes: await quotesJson(db, rows) };
}

export async function quoteHousekeeping(db: Db): Promise<{ pruned: number }> {
  const quotes = await db.query(`DELETE FROM quotes WHERE created_at < now() - interval '${RETENTION_DAYS} days'`);
  await db.query(`DELETE FROM quote_requests r WHERE created_at < now() - interval '${RETENTION_DAYS} days' AND NOT EXISTS (SELECT 1 FROM quotes q WHERE q.request_id = r.id)`);
  return { pruned: quotes.rowCount ?? 0 };
}
