// Agenda (bipe#318; docs/scheduling.md slice 1; ADRs 0099 to 0103). The API is the only slot engine
// (scheduling.ts). Bookings hold service, agenda, times, status and the customer ID only (ADR 0102): never notes.
// A hold lasts 5 minutes. No two active bookings of one agenda overlap (exclusion constraint in db.ts).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { z } from "zod";
import {
  addDays, customerOf, DEFAULT_TIME_ZONE, inTransaction, isCompany, isExclusionViolation, localParts,
  lockBusiness, validTimeZone, type Customer, type Queryable,
} from "./business-common.js";
import { CatalogItemBody, ITEM_COLUMNS, itemJson, type ItemRow } from "./catalog.js";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import type { Agenda, AgendaState, Availability, Booking, Override, Policy, Service, SlotDays, TimeRange } from "./generated/business-api.js";
import { calculateSlots, selectAgenda, type SchedulingInput } from "./scheduling.js";

const MINUTE = 60_000;
const DAY = 86_400_000;
export const HOLD_MINUTES = 5;
export const MAX_AGENDAS = 50;
export const MAX_SLOT_DAYS = 31;
export const MAX_OWNER_DAYS = 62;
export const RETENTION_DAYS = 730; // ADR 0103: two years after the booking date.
const ACTIVE = ["held", "requested", "confirmed"];

const generated = fileURLToPath(new URL("../src/generated/", import.meta.url));
type Template = {
  id: string;
  services: { id: string; name_key: string; duration_minutes: number; buffer_before_minutes: number; buffer_after_minutes: number; price: Service["price"] }[];
  availability: Availability[];
};
const templates = (JSON.parse(readFileSync(`${generated}registries/agenda-templates.json`, "utf8")) as { templates: Template[] }).templates;
const ptStrings = (JSON.parse(readFileSync(`${generated}strings/pt-BR.json`, "utf8")) as { strings: Record<string, string> }).strings;

// ---- Bodies -------------------------------------------------------------------------------------------------------

const Time = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
const Day = z.iso.date();
const Instant = z.iso.datetime().refine((v) => v.endsWith("Z"), "utc");
const Id = z.string().min(1).max(128);
const Range = z.object({ start: Time, end: Time }).strict();

export const ActivationBody = z.object({ template_id: Id, time_zone: z.string().max(64).optional() }).strict();
export const SettingsBody = z.object({ published: z.boolean(), time_zone: z.string().max(64) }).strict();
export const AgendaBody = z.object({ name: z.string().trim().min(1).max(120), photo: z.url().max(2048).optional(), active: z.boolean(), sort: z.number().int().min(0).max(1_000_000) }).strict();
export const AvailabilityBody = z.object({ rules: z.array(z.object({ weekday: z.number().int().min(1).max(7), start: Time, end: Time }).strict()).max(70) }).strict();
export const OverrideBody = z
  .object({ agenda_id: Id, date_from: Day, date_to: Day, closed: z.boolean(), ranges: z.array(Range).max(10) })
  .strict()
  .refine((o) => (o.closed ? o.ranges.length === 0 : o.ranges.length > 0), { message: "ranges", path: ["ranges"] })
  .refine((o) => o.date_to >= o.date_from, { message: "dates", path: ["date_to"] });
export const BlockBody = z.object({ agenda_ids: z.array(Id).min(1).max(MAX_AGENDAS), start: Instant, end: Instant }).strict();
export const CloseDayBody = z.object({ agenda_ids: z.array(Id).min(1).max(MAX_AGENDAS), date: Day }).strict();
export const PolicyBody = z
  .object({
    min_notice_minutes: z.number().int().min(0).max(43_200),
    horizon_days: z.number().int().min(1).max(365),
    slot_step_minutes: z.number().int().min(5).max(240),
    cancel_window_minutes: z.number().int().min(0).max(43_200),
    confirm_mode: z.enum(["auto", "request"]),
    max_open_bookings_per_customer: z.number().int().min(1).max(20),
    reminder_minutes: z.array(z.number().int().min(1).max(20_160)).max(4),
  })
  .strict();
export const ServiceBody = CatalogItemBody.refine(
  (b) => b.kind === "service" && b.duration_minutes !== undefined && b.buffer_before_minutes !== undefined && b.buffer_after_minutes !== undefined && b.agenda_ids !== undefined,
  { message: "service_fields", path: ["kind"] },
);
const CustomerBody = z.union([
  z.object({ user_id: z.string().regex(/^@[^:\s]{1,255}:[^\s]{1,255}$/) }).strict(),
  z.object({ name: z.string().trim().min(1).max(120) }).strict(),
]);
export const OwnerBookingBody = z.object({ service_id: Id, agenda_id: Id, start: Instant, customer: CustomerBody }).strict();
export const HoldBody = z.object({ service_id: Id, agenda_id: Id, start: Instant }).strict();
export const MoveBody = z.object({ agenda_id: Id, start: Instant }).strict();
export const RangeQuery = z.object({ date_from: Day, date_to: Day });

// ---- Rows ---------------------------------------------------------------------------------------------------------

type SettingsRow = {
  business_id: string;
  published: boolean;
  time_zone: string;
  min_notice_minutes: number;
  horizon_days: number;
  slot_step_minutes: number;
  cancel_window_minutes: number;
  confirm_mode: "auto" | "request";
  max_open_bookings: number;
  reminder_minutes: number[];
};
type AgendaRow = { id: string; seq: string; business_id: string; name: string; photo: string | null; active: boolean; sort: number; availability: Availability[] };
type OverrideRow = { id: string; agenda_id: string; date_from: string; date_to: string; closed: boolean; ranges: TimeRange[] };
type BookingRow = {
  id: string; business_id: string; service_id: string; agenda_id: string; start_at: Date; end_at: Date; status: Booking["status"];
  customer_id: string | null; customer_name: string | null; source: "customer" | "owner"; hold_expires_at: Date | null;
  buffer_before_minutes: number; buffer_after_minutes: number;
};
const BOOKING_COLUMNS = `id, business_id, service_id, agenda_id, start_at, end_at, status, customer_id, customer_name, source,
  hold_expires_at, buffer_before_minutes, buffer_after_minutes`;
const OVERRIDE_COLUMNS = "id, agenda_id, date_from::text AS date_from, date_to::text AS date_to, closed, ranges";

const policyJson = (s: SettingsRow): Policy => ({
  min_notice_minutes: s.min_notice_minutes,
  horizon_days: s.horizon_days,
  slot_step_minutes: s.slot_step_minutes,
  cancel_window_minutes: s.cancel_window_minutes,
  confirm_mode: s.confirm_mode,
  max_open_bookings_per_customer: s.max_open_bookings,
  reminder_minutes: s.reminder_minutes,
});
const agendaJson = (a: AgendaRow): Agenda => ({ id: a.id, name: a.name, ...(a.photo ? { photo: a.photo } : {}), active: a.active, sort: a.sort });
const overrideJson = (o: OverrideRow): Override => ({ id: o.id, agenda_id: o.agenda_id, date_from: o.date_from, date_to: o.date_to, closed: o.closed, ranges: o.ranges });

/** A confirmed booking whose end passed is done (the job also writes it). An expired hold is no longer held. */
export function bookingJson(b: BookingRow, now = Date.now()): Booking {
  const status = b.status === "confirmed" && b.end_at.getTime() <= now ? "done" : b.status;
  return {
    id: b.id,
    business_id: b.business_id,
    service_id: b.service_id,
    agenda_id: b.agenda_id,
    start: b.start_at.toISOString(),
    end: b.end_at.toISOString(),
    status,
    customer: customerOf(b) as Booking["customer"],
    source: b.source,
    ...(b.status === "held" && b.hold_expires_at ? { hold_expires_at: b.hold_expires_at.toISOString() } : {}),
  };
}

// ---- Reads --------------------------------------------------------------------------------------------------------

async function settingsOf(db: Queryable, businessId: string): Promise<SettingsRow | null> {
  const { rows } = await db.query<SettingsRow>("SELECT * FROM agenda_settings WHERE business_id = $1", [businessId]);
  return rows[0] ?? null;
}

/** Owner routes need an activated agenda; before that they answer not_found with reason agenda_off. */
async function requireSettings(db: Queryable, businessId: string): Promise<SettingsRow> {
  const settings = await settingsOf(db, businessId);
  if (!settings) throw new ApiError("not_found", "agenda_off");
  return settings;
}

async function agendasOf(db: Queryable, businessId: string): Promise<AgendaRow[]> {
  const { rows } = await db.query<AgendaRow>(
    "SELECT id, seq, business_id, name, photo, active, sort, availability FROM agendas WHERE business_id = $1 AND deleted_at IS NULL ORDER BY sort, id",
    [businessId],
  );
  return rows;
}

async function agendaRow(db: Queryable, businessId: string, agendaId: string): Promise<AgendaRow> {
  const { rows } = await db.query<AgendaRow>(
    "SELECT id, seq, business_id, name, photo, active, sort, availability FROM agendas WHERE business_id = $1 AND id = $2 AND deleted_at IS NULL",
    [businessId, agendaId],
  );
  if (!rows[0]) throw new ApiError("not_found");
  return rows[0];
}

/** Services the Agenda can schedule: catalogue items of kind service with every scheduling field. */
async function serviceRows(db: Queryable, businessId: string): Promise<ItemRow[]> {
  const { rows } = await db.query<ItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM catalog_items WHERE business_id = $1 AND archived_at IS NULL AND kind = 'service'
       AND duration_minutes IS NOT NULL AND buffer_before_minutes IS NOT NULL AND buffer_after_minutes IS NOT NULL
       AND cardinality(agenda_ids) > 0
     ORDER BY sort, id`,
    [businessId],
  );
  return rows;
}

const serviceJson = (row: ItemRow, apiUrl: string, today: string, agendaIds?: Set<string>): Service => {
  const item = itemJson(row, apiUrl, today);
  return { ...item, kind: "service", agenda_ids: (row.agenda_ids ?? []).filter((id) => !agendaIds || agendaIds.has(id)) } as Service;
};

export async function agendaState(db: Queryable, apiUrl: string, businessId: string): Promise<AgendaState> {
  const settings = await requireSettings(db, businessId);
  const today = localParts(settings.time_zone, Date.now()).date;
  const agendas = await agendasOf(db, businessId);
  const ids = new Set(agendas.map((a) => a.id));
  return {
    published: settings.published,
    time_zone: settings.time_zone,
    agendas: agendas.map(agendaJson),
    services: (await serviceRows(db, businessId)).map((r) => serviceJson(r, apiUrl, today, ids)),
    policy: policyJson(settings),
  };
}

// ---- Owner setup --------------------------------------------------------------------------------------------------

/** The first agenda carries the public profile name, else the handle, else "Agenda". The owner renames it. */
async function firstAgendaName(db: Queryable, businessId: string): Promise<string> {
  const { rows } = await db.query<{ name: string | null; handle: string | null }>(
    `SELECT (SELECT NULLIF(name, '') FROM public_profiles WHERE user_id = $1) AS name, (SELECT handle FROM handles WHERE user_id = $1) AS handle`,
    [businessId],
  );
  return (rows[0]?.name ?? rows[0]?.handle ?? ptStrings.bipe_tab_agenda ?? "Agenda").slice(0, 120);
}

export async function activate(db: Db, apiUrl: string, businessId: string, body: z.infer<typeof ActivationBody>): Promise<AgendaState> {
  const template = templates.find((t) => t.id === body.template_id);
  if (!template) throw new ApiError("bad_request", "unknown_template");
  const timeZone = body.time_zone ?? DEFAULT_TIME_ZONE;
  if (!validTimeZone(timeZone)) throw new ApiError("bad_request", "time_zone");
  await inTransaction(db, async (client) => {
    await lockBusiness(client, businessId);
    // A second activation changes nothing: no second agenda and no duplicate service.
    if (await settingsOf(client, businessId)) return;
    await client.query(
      `INSERT INTO agenda_settings (business_id, published, time_zone, min_notice_minutes, horizon_days, slot_step_minutes,
         cancel_window_minutes, confirm_mode, max_open_bookings, reminder_minutes)
       VALUES ($1, false, $2, 60, 60, 15, 120, 'auto', 2, '{1440,120}')`,
      [businessId, timeZone],
    );
    let agenda = (await agendasOf(client, businessId))[0];
    if (!agenda) {
      const { rows } = await client.query<AgendaRow>(
        "INSERT INTO agendas (id, business_id, name, active, sort, availability) VALUES ($1, $2, $3, true, 0, $4) RETURNING *",
        [randomUUID(), businessId, await firstAgendaName(client, businessId), JSON.stringify(template.availability)],
      );
      agenda = rows[0]!;
    }
    const { rows: existing } = await client.query<{ name: string; kind: string }>(
      "SELECT lower(name) AS name, kind FROM catalog_items WHERE business_id = $1 AND archived_at IS NULL",
      [businessId],
    );
    const { rows: top } = await client.query<{ n: number }>("SELECT coalesce(max(sort) + 1, 0)::int AS n FROM catalog_items WHERE business_id = $1", [businessId]);
    let sort = top[0]!.n;
    for (const service of template.services) {
      const name = ptStrings[service.name_key] ?? service.id;
      if (existing.some((e) => e.kind === "service" && e.name === name.toLowerCase())) continue;
      await client.query(
        `INSERT INTO catalog_items (id, business_id, kind, name, price, active, sort, duration_minutes, buffer_before_minutes, buffer_after_minutes, agenda_ids)
         VALUES ($1, $2, 'service', $3, $4, true, $5, $6, $7, $8, $9)`,
        [randomUUID(), businessId, name, JSON.stringify(service.price), sort++, service.duration_minutes, service.buffer_before_minutes, service.buffer_after_minutes, [agenda.id]],
      );
    }
  });
  return agendaState(db, apiUrl, businessId);
}

export async function saveSettings(db: Db, apiUrl: string, businessId: string, body: z.infer<typeof SettingsBody>): Promise<AgendaState> {
  await requireSettings(db, businessId);
  if (!validTimeZone(body.time_zone)) throw new ApiError("bad_request", "time_zone");
  if (body.published) {
    const agendas = (await agendasOf(db, businessId)).filter((a) => a.active && a.availability.length > 0);
    const active = new Set(agendas.map((a) => a.id));
    const services = (await serviceRows(db, businessId)).filter((s) => s.active && (s.agenda_ids ?? []).some((id) => active.has(id)));
    if (!services.length) throw new ApiError("bad_request", "incomplete");
  }
  await db.query("UPDATE agenda_settings SET published = $2, time_zone = $3 WHERE business_id = $1", [businessId, body.published, body.time_zone]);
  return agendaState(db, apiUrl, businessId);
}

export async function listAgendas(db: Queryable, businessId: string) {
  await requireSettings(db, businessId);
  return { agendas: (await agendasOf(db, businessId)).map(agendaJson) };
}

export async function createAgenda(db: Queryable, businessId: string, body: z.infer<typeof AgendaBody>): Promise<Agenda> {
  await requireSettings(db, businessId);
  if ((await agendasOf(db, businessId)).length >= MAX_AGENDAS) throw new ApiError("bad_request", "too_many_agendas");
  // A new person starts with the hours of the first agenda; the owner changes them in setup.
  const first = (await agendasOf(db, businessId))[0];
  const { rows } = await db.query<AgendaRow>(
    "INSERT INTO agendas (id, business_id, name, photo, active, sort, availability) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *",
    [randomUUID(), businessId, body.name, body.photo ?? null, body.active, body.sort, JSON.stringify(first?.availability ?? [])],
  );
  return agendaJson(rows[0]!);
}

export async function replaceAgenda(db: Queryable, businessId: string, agendaId: string, body: z.infer<typeof AgendaBody>): Promise<Agenda> {
  await agendaRow(db, businessId, agendaId);
  const { rows } = await db.query<AgendaRow>(
    "UPDATE agendas SET name = $3, photo = $4, active = $5, sort = $6 WHERE business_id = $1 AND id = $2 RETURNING *",
    [businessId, agendaId, body.name, body.photo ?? null, body.active, body.sort],
  );
  return agendaJson(rows[0]!);
}

/** Bookings and history keep the agenda row; it only leaves every list. */
export async function deleteAgenda(db: Queryable, businessId: string, agendaId: string): Promise<void> {
  await agendaRow(db, businessId, agendaId);
  await db.query("UPDATE agendas SET deleted_at = now(), active = false WHERE business_id = $1 AND id = $2", [businessId, agendaId]);
  await db.query("UPDATE catalog_items SET agenda_ids = array_remove(agenda_ids, $2), updated_at = now() WHERE business_id = $1 AND $2 = ANY(agenda_ids)", [businessId, agendaId]);
}

function minutes(t: string): number {
  return Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
}
function clock(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Ranges of one day: each end after its start, none overlapping. */
function checkRanges(ranges: TimeRange[]): void {
  const sorted = ranges.map((r) => [minutes(r.start), minutes(r.end)] as const).sort((a, b) => a[0] - b[0]);
  sorted.forEach(([start, end], i) => {
    if (end <= start || (i > 0 && start < sorted[i - 1]![1])) throw new ApiError("bad_request", "ranges");
  });
}

export async function availabilityOf(db: Queryable, businessId: string, agendaId: string) {
  return { rules: (await agendaRow(db, businessId, agendaId)).availability };
}

export async function setAvailability(db: Queryable, businessId: string, agendaId: string, body: z.infer<typeof AvailabilityBody>) {
  await agendaRow(db, businessId, agendaId);
  for (let weekday = 1; weekday <= 7; weekday++) checkRanges(body.rules.filter((r) => r.weekday === weekday));
  const rules = [...body.rules].sort((a, b) => a.weekday - b.weekday || minutes(a.start) - minutes(b.start));
  await db.query("UPDATE agendas SET availability = $3 WHERE business_id = $1 AND id = $2", [businessId, agendaId, JSON.stringify(rules)]);
  return { rules };
}

// ---- Overrides, blocks, close day ----------------------------------------------------------------------------------

export async function listOverrides(db: Queryable, businessId: string, from?: string, to?: string) {
  await requireSettings(db, businessId);
  const { rows } = await db.query<OverrideRow>(
    `SELECT ${OVERRIDE_COLUMNS} FROM agenda_overrides WHERE business_id = $1
       AND ($2::date IS NULL OR date_to >= $2::date) AND ($3::date IS NULL OR date_from <= $3::date)
     ORDER BY date_from, agenda_id, id LIMIT 1000`,
    [businessId, from ?? null, to ?? null],
  );
  return { overrides: rows.map(overrideJson) };
}

async function checkOverlap(db: Queryable, agendaId: string, from: string, to: string, except?: string): Promise<void> {
  const { rowCount } = await db.query(
    "SELECT 1 FROM agenda_overrides WHERE agenda_id = $1 AND date_from <= $3::date AND date_to >= $2::date AND id IS DISTINCT FROM $4",
    [agendaId, from, to, except ?? null],
  );
  if (rowCount) throw new ApiError("bad_request", "override_overlap");
}

export async function createOverride(db: Db, businessId: string, body: z.infer<typeof OverrideBody>): Promise<Override> {
  await requireSettings(db, businessId);
  await agendaRow(db, businessId, body.agenda_id);
  checkRanges(body.ranges);
  return inTransaction(db, async (client) => {
    await lockBusiness(client, businessId);
    await checkOverlap(client, body.agenda_id, body.date_from, body.date_to);
    const { rows } = await client.query<OverrideRow>(
      `INSERT INTO agenda_overrides (id, business_id, agenda_id, date_from, date_to, closed, ranges) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${OVERRIDE_COLUMNS}`,
      [randomUUID(), businessId, body.agenda_id, body.date_from, body.date_to, body.closed, JSON.stringify(body.ranges)],
    );
    return overrideJson(rows[0]!);
  });
}

export async function replaceOverride(db: Db, businessId: string, overrideId: string, body: z.infer<typeof OverrideBody>): Promise<Override> {
  await agendaRow(db, businessId, body.agenda_id);
  checkRanges(body.ranges);
  return inTransaction(db, async (client) => {
    await lockBusiness(client, businessId);
    await checkOverlap(client, body.agenda_id, body.date_from, body.date_to, overrideId);
    const { rows } = await client.query<OverrideRow>(
      `UPDATE agenda_overrides SET agenda_id = $3, date_from = $4, date_to = $5, closed = $6, ranges = $7
       WHERE business_id = $1 AND id = $2 RETURNING ${OVERRIDE_COLUMNS}`,
      [businessId, overrideId, body.agenda_id, body.date_from, body.date_to, body.closed, JSON.stringify(body.ranges)],
    );
    if (!rows[0]) throw new ApiError("not_found");
    return overrideJson(rows[0]);
  });
}

export async function deleteOverride(db: Queryable, businessId: string, overrideId: string): Promise<void> {
  const { rowCount } = await db.query("DELETE FROM agenda_overrides WHERE business_id = $1 AND id = $2", [businessId, overrideId]);
  if (!rowCount) throw new ApiError("not_found");
}

/**
 * Sets the hours of one local date on one agenda, with what change makes of the day's current hours. An override
 * over several dates is split so that only this date changes.
 */
async function rewriteDay(client: pg.PoolClient, businessId: string, agenda: AgendaRow, date: string, change: (ranges: TimeRange[]) => TimeRange[]): Promise<Override> {
  const { rows } = await client.query<OverrideRow>(
    `SELECT ${OVERRIDE_COLUMNS} FROM agenda_overrides WHERE agenda_id = $1 AND date_from <= $2::date AND date_to >= $2::date`,
    [agenda.id, date],
  );
  const current = rows[0];
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
  const before = current ? (current.closed ? [] : current.ranges) : agenda.availability.filter((r) => r.weekday === weekday).map(({ start, end }) => ({ start, end }));
  const after = change(before);
  if (current) {
    await client.query("DELETE FROM agenda_overrides WHERE id = $1", [current.id]);
    const keep = async (from: string, to: string) =>
      client.query("INSERT INTO agenda_overrides (id, business_id, agenda_id, date_from, date_to, closed, ranges) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
        randomUUID(), businessId, agenda.id, from, to, current.closed, JSON.stringify(current.ranges),
      ]);
    if (current.date_from < date) await keep(current.date_from, addDays(date, -1));
    if (current.date_to > date) await keep(addDays(date, 1), current.date_to);
  }
  const { rows: made } = await client.query<OverrideRow>(
    `INSERT INTO agenda_overrides (id, business_id, agenda_id, date_from, date_to, closed, ranges) VALUES ($1, $2, $3, $4, $4, $5, $6)
     RETURNING ${OVERRIDE_COLUMNS}`,
    [randomUUID(), businessId, agenda.id, date, after.length === 0, JSON.stringify(after)],
  );
  return overrideJson(made[0]!);
}

/** Removes the local minutes [from, to) from a day's ranges. */
function subtract(ranges: TimeRange[], from: number, to: number): TimeRange[] {
  const out: TimeRange[] = [];
  for (const r of ranges) {
    const [s, e] = [minutes(r.start), minutes(r.end)];
    if (to <= s || e <= from) { out.push(r); continue; }
    if (s < from) out.push({ start: r.start, end: clock(from) });
    if (to < e) out.push({ start: clock(to), end: r.end });
  }
  return out;
}

export async function block(db: Db, businessId: string, body: z.infer<typeof BlockBody>): Promise<Override> {
  const settings = await requireSettings(db, businessId);
  const start = Date.parse(body.start);
  const end = Date.parse(body.end);
  if (end <= start || end - start > 31 * DAY) throw new ApiError("bad_request", "end");
  const agendas = await Promise.all(body.agenda_ids.map((id) => agendaRow(db, businessId, id)));
  return inTransaction(db, async (client) => {
    await lockBusiness(client, businessId);
    let first: Override | undefined;
    const from = localParts(settings.time_zone, start);
    const to = localParts(settings.time_zone, end - MINUTE);
    for (let date = from.date; date <= to.date; date = addDays(date, 1)) {
      const startMinute = date === from.date ? from.minute : 0;
      const endMinute = date === to.date ? to.minute + 1 : 1440;
      for (const agenda of agendas) {
        const made = await rewriteDay(client, businessId, agenda, date, (ranges) => subtract(ranges, startMinute, endMinute));
        first ??= made;
      }
    }
    return first!;
  });
}

export async function closeDay(db: Db, businessId: string, body: z.infer<typeof CloseDayBody>): Promise<Override> {
  await requireSettings(db, businessId);
  const agendas = await Promise.all(body.agenda_ids.map((id) => agendaRow(db, businessId, id)));
  return inTransaction(db, async (client) => {
    await lockBusiness(client, businessId);
    let first: Override | undefined;
    for (const agenda of agendas) first ??= await rewriteDay(client, businessId, agenda, body.date, () => []);
    return first!;
  });
}

// ---- Services and policy --------------------------------------------------------------------------------------------

export async function listServices(db: Queryable, apiUrl: string, businessId: string) {
  const settings = await requireSettings(db, businessId);
  const ids = new Set((await agendasOf(db, businessId)).map((a) => a.id));
  const today = localParts(settings.time_zone, Date.now()).date;
  return { services: (await serviceRows(db, businessId)).map((r) => serviceJson(r, apiUrl, today, ids)) };
}

export async function policyOf(db: Queryable, businessId: string): Promise<Policy> {
  return policyJson(await requireSettings(db, businessId));
}

export async function setPolicy(db: Queryable, businessId: string, body: z.infer<typeof PolicyBody>): Promise<Policy> {
  await requireSettings(db, businessId);
  const { rows } = await db.query<SettingsRow>(
    `UPDATE agenda_settings SET min_notice_minutes = $2, horizon_days = $3, slot_step_minutes = $4, cancel_window_minutes = $5,
       confirm_mode = $6, max_open_bookings = $7, reminder_minutes = $8 WHERE business_id = $1 RETURNING *`,
    [businessId, body.min_notice_minutes, body.horizon_days, body.slot_step_minutes, body.cancel_window_minutes, body.confirm_mode,
      body.max_open_bookings_per_customer, [...new Set(body.reminder_minutes)]],
  );
  return policyJson(rows[0]!);
}

// ---- Slot engine input ----------------------------------------------------------------------------------------------

/** A fresh snapshot for scheduling.ts. Expired holds stay out; the engine skips them anyway. */
async function snapshot(db: Queryable, settings: SettingsRow, serviceId: string, agendaId: string, dateFrom: string, dateTo: string, exceptBooking?: string): Promise<SchedulingInput> {
  const agendas = await agendasOf(db, settings.business_id);
  const ids = new Set(agendas.map((a) => a.id));
  const services = await serviceRows(db, settings.business_id);
  const { rows: overrides } = await db.query<OverrideRow>(`SELECT ${OVERRIDE_COLUMNS} FROM agenda_overrides WHERE business_id = $1 AND agenda_id = ANY($2)`, [
    settings.business_id, [...ids],
  ]);
  // One day of margin on each side covers every time zone offset and the widest buffer.
  const { rows: bookings } = await db.query<BookingRow>(
    `SELECT ${BOOKING_COLUMNS} FROM bookings WHERE business_id = $1 AND agenda_id = ANY($2)
       AND status IN ('held', 'requested', 'confirmed', 'done') AND end_at > $3::date - 2 AND start_at < $4::date + 3
       AND id IS DISTINCT FROM $5`,
    [settings.business_id, [...ids], dateFrom, dateTo, exceptBooking ?? null],
  );
  return {
    time_zone: settings.time_zone,
    agendas: agendas.map((a) => ({ id: a.id, active: a.active, sort: a.sort, availability: a.availability })),
    services: services.map((s) => ({
      id: s.id,
      active: s.active,
      agenda_ids: (s.agenda_ids ?? []).filter((id) => ids.has(id)),
      duration_minutes: s.duration_minutes!,
      buffer_before_minutes: s.buffer_before_minutes!,
      buffer_after_minutes: s.buffer_after_minutes!,
    })),
    overrides: overrides.map(({ agenda_id, date_from, date_to, closed, ranges }) => ({ agenda_id, date_from, date_to, closed, ranges })),
    policy: { min_notice_minutes: settings.min_notice_minutes, horizon_days: settings.horizon_days, slot_step_minutes: settings.slot_step_minutes },
    bookings: bookings.map((b) => ({
      agenda_id: b.agenda_id,
      start: b.start_at.toISOString(),
      end: b.end_at.toISOString(),
      status: b.status,
      ...(b.hold_expires_at ? { hold_expires_at: b.hold_expires_at.toISOString() } : {}),
      buffer_before_minutes: b.buffer_before_minutes,
      buffer_after_minutes: b.buffer_after_minutes,
    })),
    busy_blocks: [],
    now: new Date().toISOString(),
    service_id: serviceId,
    agenda_id: agendaId,
    date_from: dateFrom,
    date_to: dateTo,
  };
}

async function publishedSettings(db: Queryable, businessId: string): Promise<SettingsRow> {
  const settings = await settingsOf(db, businessId);
  if (!settings || !settings.published) throw new ApiError("agenda_not_published");
  return settings;
}

// ---- Public customer reads ------------------------------------------------------------------------------------------

export async function publicServices(db: Queryable, apiUrl: string, businessId: string) {
  const settings = await publishedSettings(db, businessId);
  const active = new Set((await agendasOf(db, businessId)).filter((a) => a.active).map((a) => a.id));
  const today = localParts(settings.time_zone, Date.now()).date;
  return {
    services: (await serviceRows(db, businessId))
      .filter((s) => s.active && (s.agenda_ids ?? []).some((id) => active.has(id)))
      .map((r) => serviceJson(r, apiUrl, today, active)),
  };
}

export async function publicAgendas(db: Queryable, businessId: string, serviceId?: string) {
  await publishedSettings(db, businessId);
  let agendas = (await agendasOf(db, businessId)).filter((a) => a.active);
  if (serviceId) {
    const service = (await serviceRows(db, businessId)).find((s) => s.id === serviceId && s.active);
    if (!service) throw new ApiError("not_found");
    agendas = agendas.filter((a) => service.agenda_ids?.includes(a.id));
  }
  return { agendas: agendas.map(agendaJson) };
}

export const SlotsQuery = z.object({ service_id: Id, agenda_id: Id.default("any"), date_from: Day, date_to: Day });

export async function slots(db: Queryable, businessId: string, query: z.infer<typeof SlotsQuery>): Promise<SlotDays> {
  const settings = await publishedSettings(db, businessId);
  const days = (Date.parse(query.date_to) - Date.parse(query.date_from)) / DAY;
  if (days < 0 || days >= MAX_SLOT_DAYS) throw new ApiError("bad_request", "date_range");
  const input = await snapshot(db, settings, query.service_id, query.agenda_id, query.date_from, query.date_to);
  if (!input.services.some((s) => s.id === query.service_id && s.active)) throw new ApiError("not_found");
  if (query.agenda_id !== "any" && !input.agendas.some((a) => a.id === query.agenda_id)) throw new ApiError("not_found");
  return calculateSlots(input);
}

// ---- Bookings --------------------------------------------------------------------------------------------------------

/**
 * The agenda that can take this start for this service now, or the policy error that explains why none can.
 * Runs inside the caller's transaction, after lockBusiness, on a fresh snapshot.
 */
async function freeAgenda(client: pg.PoolClient, settings: SettingsRow, serviceId: string, agendaId: string, start: string, exceptBooking?: string): Promise<{ agenda: string; service: SchedulingInput["services"][number] }> {
  const instant = Date.parse(start);
  const now = Date.now();
  if (instant < now + settings.min_notice_minutes * MINUTE) throw new ApiError("outside_notice");
  if (instant > now + settings.horizon_days * DAY) throw new ApiError("outside_horizon");
  const date = localParts(settings.time_zone, instant).date;
  const input = await snapshot(client, settings, serviceId, agendaId, date, date, exceptBooking);
  const service = input.services.find((s) => s.id === serviceId && s.active);
  if (!service) throw new ApiError("not_found");
  if (agendaId !== "any" && !input.agendas.some((a) => a.id === agendaId && a.active)) throw new ApiError("not_found");
  const picked = selectAgenda(input, new Date(instant).toISOString());
  if (!picked) throw new ApiError("slot_taken");
  return { agenda: picked, service };
}

async function insertBooking(
  client: pg.PoolClient,
  b: { businessId: string; serviceId: string; agendaId: string; start: number; service: { duration_minutes: number; buffer_before_minutes: number; buffer_after_minutes: number }; status: Booking["status"]; customer: Customer; source: "customer" | "owner"; holdExpiresAt: Date | null },
): Promise<BookingRow> {
  const end = b.start + b.service.duration_minutes * MINUTE;
  try {
    await client.query("SAVEPOINT booking_insert");
    const { rows } = await client.query<BookingRow>(
      `INSERT INTO bookings (id, business_id, service_id, agenda_id, agenda_seq, start_at, end_at, busy_start, busy_end,
         buffer_before_minutes, buffer_after_minutes, status, customer_id, customer_name, source, hold_expires_at)
       VALUES ($1, $2, $3, $4, (SELECT seq FROM agendas WHERE id = $4), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING ${BOOKING_COLUMNS}`,
      [
        randomUUID(), b.businessId, b.serviceId, b.agendaId, new Date(b.start), new Date(end),
        new Date(b.start - b.service.buffer_before_minutes * MINUTE), new Date(end + b.service.buffer_after_minutes * MINUTE),
        b.service.buffer_before_minutes, b.service.buffer_after_minutes, b.status,
        "user_id" in b.customer ? b.customer.user_id : null, "name" in b.customer ? b.customer.name : null, b.source, b.holdExpiresAt,
      ],
    );
    return rows[0]!;
  } catch (e) {
    if (isExclusionViolation(e)) {
      await client.query("ROLLBACK TO SAVEPOINT booking_insert");
      throw new ApiError("slot_taken");
    }
    throw e;
  }
}

/** Ends holds that passed their 5 minutes, so they leave the exclusion constraint. */
async function expireHolds(db: Queryable, businessId: string): Promise<void> {
  await db.query(
    "UPDATE bookings SET status = 'cancelled', ended_reason = 'hold_expired', updated_at = now() WHERE business_id = $1 AND status = 'held' AND hold_expires_at <= now()",
    [businessId],
  );
}

export async function hold(db: Db, businessId: string, customerId: string, body: z.infer<typeof HoldBody>): Promise<Booking> {
  if (customerId === businessId) throw new ApiError("bad_request", "own_business");
  return inTransaction(db, async (client) => {
    await lockBusiness(client, businessId);
    const settings = await publishedSettings(client, businessId);
    await expireHolds(client, businessId);
    const { rows: open } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM bookings WHERE business_id = $1 AND customer_id = $2 AND status = ANY($3) AND end_at > now()",
      [businessId, customerId, ACTIVE],
    );
    if (open[0]!.n >= settings.max_open_bookings) throw new ApiError("too_many_open_bookings");
    const { agenda, service } = await freeAgenda(client, settings, body.service_id, body.agenda_id, body.start);
    const row = await insertBooking(client, {
      businessId, serviceId: service.id, agendaId: agenda, start: Date.parse(body.start), service, status: "held",
      customer: { user_id: customerId }, source: "customer", holdExpiresAt: new Date(Date.now() + HOLD_MINUTES * MINUTE),
    });
    return bookingJson(row);
  });
}

async function customerBooking(client: Queryable, businessId: string, customerId: string, bookingId: string): Promise<BookingRow> {
  const { rows } = await client.query<BookingRow>(
    `SELECT ${BOOKING_COLUMNS} FROM bookings WHERE id = $1 AND business_id = $2 AND customer_id = $3 FOR UPDATE`,
    [bookingId, businessId, customerId],
  );
  if (!rows[0]) throw new ApiError("not_found");
  return rows[0];
}

async function update(client: Queryable, id: string, set: string, params: unknown[] = []): Promise<BookingRow> {
  const { rows } = await client.query<BookingRow>(`UPDATE bookings SET ${set}, updated_at = now() WHERE id = $1 RETURNING ${BOOKING_COLUMNS}`, [id, ...params]);
  return rows[0]!;
}

export async function confirm(db: Db, businessId: string, customerId: string, bookingId: string): Promise<Booking> {
  return inTransaction(db, async (client) => {
    const settings = await publishedSettings(client, businessId);
    const booking = await customerBooking(client, businessId, customerId, bookingId);
    if (booking.status === "confirmed" || booking.status === "requested") return bookingJson(booking);
    if (booking.status !== "held") throw new ApiError(booking.status === "cancelled" ? "hold_expired" : "bad_request", booking.status);
    if (!booking.hold_expires_at || booking.hold_expires_at.getTime() <= Date.now()) {
      await update(client, booking.id, "status = 'cancelled', ended_reason = 'hold_expired'");
      throw new ApiError("hold_expired");
    }
    const status = settings.confirm_mode === "request" ? "requested" : "confirmed";
    return bookingJson(await update(client, booking.id, "status = $2, hold_expires_at = NULL", [status]));
  });
}

function checkWindow(settings: SettingsRow, booking: BookingRow): void {
  if (booking.status === "held") return;
  if (booking.start_at.getTime() - Date.now() < settings.cancel_window_minutes * MINUTE) throw new ApiError("cancellation_window_closed");
}

export async function customerCancel(db: Db, businessId: string, customerId: string, bookingId: string): Promise<Booking> {
  return inTransaction(db, async (client) => {
    const settings = await requireSettings(client, businessId);
    const booking = await customerBooking(client, businessId, customerId, bookingId);
    if (booking.status === "cancelled") return bookingJson(booking);
    if (!ACTIVE.includes(booking.status) || booking.end_at.getTime() <= Date.now()) throw new ApiError("bad_request", "not_open");
    checkWindow(settings, booking);
    return bookingJson(await update(client, booking.id, "status = 'cancelled', ended_reason = 'customer', hold_expires_at = NULL"));
  });
}

async function moveRow(client: pg.PoolClient, settings: SettingsRow, booking: BookingRow, agendaId: string, start: string, owner: boolean): Promise<BookingRow> {
  let agenda = agendaId;
  let service: { duration_minutes: number; buffer_before_minutes: number; buffer_after_minutes: number };
  if (owner) {
    // The owner may place a booking outside the published hours (encaixe); only overlaps are refused.
    const row = await agendaRow(client, settings.business_id, agendaId);
    agenda = row.id;
    service = { duration_minutes: (booking.end_at.getTime() - booking.start_at.getTime()) / MINUTE, buffer_before_minutes: booking.buffer_before_minutes, buffer_after_minutes: booking.buffer_after_minutes };
  } else {
    ({ agenda, service } = await freeAgenda(client, settings, booking.service_id, agendaId, start, booking.id));
  }
  const startAt = Date.parse(start);
  const endAt = startAt + service.duration_minutes * MINUTE;
  try {
    await client.query("SAVEPOINT booking_move");
    return await update(
      client, booking.id,
      `agenda_id = $2, agenda_seq = (SELECT seq FROM agendas WHERE id = $2), start_at = $3, end_at = $4, busy_start = $5, busy_end = $6,
       buffer_before_minutes = $7, buffer_after_minutes = $8`,
      [agenda, new Date(startAt), new Date(endAt), new Date(startAt - service.buffer_before_minutes * MINUTE), new Date(endAt + service.buffer_after_minutes * MINUTE),
        service.buffer_before_minutes, service.buffer_after_minutes],
    );
  } catch (e) {
    if (isExclusionViolation(e)) {
      await client.query("ROLLBACK TO SAVEPOINT booking_move");
      throw new ApiError("slot_taken");
    }
    throw e;
  }
}

export async function customerMove(db: Db, businessId: string, customerId: string, bookingId: string, body: z.infer<typeof MoveBody>): Promise<Booking> {
  return inTransaction(db, async (client) => {
    await lockBusiness(client, businessId);
    const settings = await publishedSettings(client, businessId);
    await expireHolds(client, businessId);
    const booking = await customerBooking(client, businessId, customerId, bookingId);
    if (!ACTIVE.includes(booking.status) || booking.end_at.getTime() <= Date.now()) throw new ApiError("bad_request", "not_open");
    checkWindow(settings, booking);
    return bookingJson(await moveRow(client, settings, booking, body.agenda_id, body.start, false));
  });
}

// ---- Owner bookings --------------------------------------------------------------------------------------------------

export const OwnerBookingsQuery = z.object({ date_from: Day, date_to: Day, agenda_id: Id.optional() });

/** Bookings that start on the local dates, every status but expired holds. */
export async function ownerBookings(db: Queryable, businessId: string, query: z.infer<typeof OwnerBookingsQuery>) {
  const settings = await requireSettings(db, businessId);
  if (query.date_to < query.date_from || (Date.parse(query.date_to) - Date.parse(query.date_from)) / DAY >= MAX_OWNER_DAYS) throw new ApiError("bad_request", "date_range");
  const { rows } = await db.query<BookingRow>(
    `SELECT ${BOOKING_COLUMNS} FROM bookings WHERE business_id = $1
       AND start_at >= ($2::date::timestamp AT TIME ZONE $4) AND start_at < (($3::date + 1)::timestamp AT TIME ZONE $4)
       AND ($5::text IS NULL OR agenda_id = $5) AND NOT (status = 'held' AND hold_expires_at <= now()) AND ended_reason IS DISTINCT FROM 'hold_expired'
     ORDER BY start_at, id LIMIT 2000`,
    [businessId, query.date_from, query.date_to, settings.time_zone, query.agenda_id ?? null],
  );
  return { bookings: rows.map((r) => bookingJson(r)) };
}

export async function ownerBook(db: Db, businessId: string, body: z.infer<typeof OwnerBookingBody>): Promise<Booking> {
  return inTransaction(db, async (client) => {
    await lockBusiness(client, businessId);
    await requireSettings(client, businessId);
    await expireHolds(client, businessId);
    const agenda = await agendaRow(client, businessId, body.agenda_id);
    const service = (await serviceRows(client, businessId)).find((s) => s.id === body.service_id);
    if (!service) throw new ApiError("not_found");
    const row = await insertBooking(client, {
      businessId, serviceId: service.id, agendaId: agenda.id, start: Date.parse(body.start),
      service: { duration_minutes: service.duration_minutes!, buffer_before_minutes: service.buffer_before_minutes!, buffer_after_minutes: service.buffer_after_minutes! },
      status: "confirmed", customer: body.customer, source: "owner", holdExpiresAt: null,
    });
    return bookingJson(row);
  });
}

async function ownerBooking(client: Queryable, businessId: string, bookingId: string): Promise<BookingRow> {
  const { rows } = await client.query<BookingRow>(`SELECT ${BOOKING_COLUMNS} FROM bookings WHERE id = $1 AND business_id = $2 FOR UPDATE`, [bookingId, businessId]);
  if (!rows[0]) throw new ApiError("not_found");
  return rows[0];
}

export async function ownerMove(db: Db, businessId: string, bookingId: string, body: z.infer<typeof MoveBody>): Promise<Booking> {
  return inTransaction(db, async (client) => {
    await lockBusiness(client, businessId);
    const settings = await requireSettings(client, businessId);
    await expireHolds(client, businessId);
    const booking = await ownerBooking(client, businessId, bookingId);
    if (!["requested", "confirmed"].includes(booking.status)) throw new ApiError("bad_request", "not_open");
    return bookingJson(await moveRow(client, settings, booking, body.agenda_id, body.start, true));
  });
}

type OwnerAction = "cancel" | "no-show" | "accept" | "refuse";

export async function ownerAction(db: Db, businessId: string, bookingId: string, action: OwnerAction): Promise<Booking> {
  return inTransaction(db, async (client) => {
    await requireSettings(client, businessId);
    const booking = await ownerBooking(client, businessId, bookingId);
    const now = Date.now();
    switch (action) {
      case "cancel":
        if (booking.status === "cancelled") return bookingJson(booking);
        if (!ACTIVE.includes(booking.status)) throw new ApiError("bad_request", "not_open");
        return bookingJson(await update(client, booking.id, "status = 'cancelled', ended_reason = 'owner', hold_expires_at = NULL"));
      case "no-show":
        if (booking.status === "no_show") return bookingJson(booking);
        if (!["confirmed", "done"].includes(booking.status) || booking.start_at.getTime() > now) throw new ApiError("bad_request", "not_started");
        return bookingJson(await update(client, booking.id, "status = 'no_show'"));
      case "accept":
        if (booking.status === "confirmed") return bookingJson(booking);
        if (booking.status !== "requested") throw new ApiError("bad_request", "not_requested");
        return bookingJson(await update(client, booking.id, "status = 'confirmed'"));
      case "refuse":
        if (booking.status !== "requested") throw new ApiError("bad_request", "not_requested");
        return bookingJson(await update(client, booking.id, "status = 'cancelled', ended_reason = 'owner'"));
    }
  });
}

/** ADR 0102: the card in the chat comes from here. A company sees its own bookings, a person their own. */
export async function myBookings(db: Queryable, userId: string) {
  const company = await isCompany(db, userId);
  const { rows } = await db.query<BookingRow>(
    `SELECT ${BOOKING_COLUMNS} FROM bookings WHERE ${company ? "business_id" : "customer_id"} = $1
       AND end_at > now() AND (status IN ('requested', 'confirmed') OR (status = 'held' AND hold_expires_at > now()))
     ORDER BY start_at, id LIMIT 500`,
    [userId],
  );
  return { bookings: rows.map((r) => bookingJson(r)) };
}

/** The job: confirmed bookings past their end become done; bookings older than two years go (ADR 0103). */
export async function agendaHousekeeping(db: Db): Promise<{ done: number; expired: number; pruned: number }> {
  const done = await db.query("UPDATE bookings SET status = 'done', updated_at = now() WHERE status = 'confirmed' AND end_at <= now()");
  const expired = await db.query("UPDATE bookings SET status = 'cancelled', ended_reason = 'hold_expired', updated_at = now() WHERE status = 'held' AND hold_expires_at <= now()");
  const pruned = await db.query(`DELETE FROM bookings WHERE end_at < now() - interval '${RETENTION_DAYS} days'`);
  return { done: done.rowCount ?? 0, expired: expired.rowCount ?? 0, pruned: pruned.rowCount ?? 0 };
}
