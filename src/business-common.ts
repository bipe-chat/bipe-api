// Shared parts of the business tools (Catálogo, Agenda, Fila virtual, Orçamento, Pedidos; ADRs 0099 to 0107).
// Owner routes: the caller is the company account itself (a device of it, ADR 0078). Customer routes name the
// business by its handle, or by its Matrix ID when it has no handle.
import type pg from "pg";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";

export type Queryable = Db | pg.PoolClient;

export const DEFAULT_TIME_ZONE = "America/Sao_Paulo";
const MATRIX_ID = /^@[^:\s]{1,255}:[^\s]{1,255}$/;

export async function isCompany(db: Queryable, userId: string): Promise<boolean> {
  const { rows } = await db.query<{ account_type: string }>("SELECT account_type FROM signups WHERE user_id = $1", [userId]);
  return rows[0]?.account_type === "company";
}

/** Owner routes: only a company account. Every other account gets not_found, so the routes do not leak. */
export async function requireCompany(db: Queryable, userId: string): Promise<string> {
  if (!(await isCompany(db, userId))) throw new ApiError("not_found", "not_company");
  return userId;
}

/** The company account named in a customer route: its handle, or its Matrix ID. Anything else is not_found. */
export async function businessOf(db: Queryable, raw: string): Promise<string> {
  let userId: string | undefined;
  if (MATRIX_ID.test(raw)) {
    userId = raw;
  } else {
    const { rows } = await db.query<{ user_id: string }>("SELECT user_id FROM handles WHERE handle = $1", [raw.replace(/^@/, "").toLowerCase()]);
    userId = rows[0]?.user_id;
  }
  if (!userId || !(await isCompany(db, userId))) throw new ApiError("not_found");
  return userId;
}

/** Runs fn in one transaction on one connection. */
export async function inTransaction<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Serialises writes that read then decide (holds, joins, open orders) for one business. */
export async function lockBusiness(client: pg.PoolClient, businessId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(7140155, hashtext($1))", [businessId]);
}

export function validTimeZone(tz: string): boolean {
  if (!tz || /^[+-]/.test(tz) || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The business time zone: the Agenda's when it is on, else the default. */
export async function businessTimeZone(db: Queryable, businessId: string): Promise<string> {
  const { rows } = await db.query<{ time_zone: string }>("SELECT time_zone FROM agenda_settings WHERE business_id = $1", [businessId]);
  return rows[0]?.time_zone ?? DEFAULT_TIME_ZONE;
}

/** Local date (YYYY-MM-DD), minute of the day and ISO weekday of an instant in a time zone. */
export function localParts(timeZone: string, instant: number): { date: string; minute: number; weekday: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone, calendar: "iso8601", numberingSystem: "latn", hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(instant).map(({ type, value }) => [type, value]),
  );
  const date = `${parts.year!.padStart(4, "0")}-${parts.month}-${parts.day}`;
  return { date, minute: Number(parts.hour) * 60 + Number(parts.minute), weekday: new Date(`${date}T00:00:00Z`).getUTCDay() || 7 };
}

/** Adds days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export const iso = (d: Date) => d.toISOString();

export type Customer = { user_id: string } | { name: string };
export function customerOf(row: { customer_id: string | null; customer_name: string | null }): Customer {
  return row.customer_id ? { user_id: row.customer_id } : { name: row.customer_name ?? "" };
}

/** Postgres exclusion violation (23P01): a concurrent booking took the time. */
export function isExclusionViolation(e: unknown): boolean {
  return (e as { code?: string }).code === "23P01";
}
