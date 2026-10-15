import type { Agenda, Availability, Booking, OverrideInput, Policy, Service, SlotDays, TimeRange } from "./generated/business-api.js";

export type SchedulingAgenda = Pick<Agenda, "id" | "active" | "sort"> & { availability: Availability[] };
export type SchedulingService = Pick<Service, "id" | "active" | "agenda_ids" | "duration_minutes" | "buffer_before_minutes" | "buffer_after_minutes">;
// Persist these buffers with the booking: editing a service must not move an existing busy interval.
export type SchedulingBooking = Pick<Booking, "agenda_id" | "start" | "end" | "status" | "hold_expires_at"> & {
  buffer_before_minutes: number;
  buffer_after_minutes: number;
};
export type SchedulingInput = {
  time_zone: string;
  agendas: SchedulingAgenda[];
  services: SchedulingService[];
  overrides: OverrideInput[];
  policy: Pick<Policy, "min_notice_minutes" | "horizon_days" | "slot_step_minutes">;
  bookings: SchedulingBooking[];
  busy_blocks: { agenda_id: string; start: string; end: string }[];
  now: string;
  service_id: string;
  agenda_id: string;
  date_from: string;
  date_to: string;
};

const MINUTE = 60_000;
const DAY = 1440 * MINUTE;
type Interval = { start: number; end: number };
type ClockMinute = { instant: number; minute: number };

/** Pure availability calculation. No database, clock, credentials or booking/customer data in the result. */
export function calculateSlots(input: SchedulingInput): SlotDays {
  return calculate(input).slots;
}

/** Call again with a fresh snapshot inside the future hold transaction; this does not reserve anything. */
export function selectAgenda(input: SchedulingInput, start: string): string | null {
  return calculate(input).picks.get(utc(start)) ?? null;
}

function calculate(input: SchedulingInput): { slots: SlotDays; picks: Map<number, string> } {
  if (typeof input.time_zone !== "string" || !input.time_zone || /^[+-]/.test(input.time_zone)) throw new RangeError("scheduling requires an IANA time zone");
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: input.time_zone, calendar: "iso8601", numberingSystem: "latn", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const from = localDate(input.date_from);
  const to = localDate(input.date_to);
  // A caller can page longer queries. Bound work before enumerating clock minutes.
  if (to < from || (to - from) / DAY >= 366) throw new RangeError("scheduling date range must contain 1 to 366 days");
  const now = utc(input.now);
  const { min_notice_minutes: notice, horizon_days: horizon, slot_step_minutes: step } = input.policy;
  integer(notice, 0); integer(horizon, 1); integer(step, 1);
  const agendaIds = uniqueIds(input.agendas);
  uniqueIds(input.services);
  for (const agenda of input.agendas) {
    integer(agenda.sort, 0);
    if (typeof agenda.active !== "boolean") throw new RangeError("invalid agenda state");
    for (const rule of agenda.availability) integer(rule.weekday, 1, 7);
    for (let weekday = 1; weekday <= 7; weekday++) validateRanges(agenda.availability.filter((rule) => rule.weekday === weekday));
  }
  for (const service of input.services) {
    integer(service.duration_minutes, 1);
    integer(service.buffer_before_minutes, 0); integer(service.buffer_after_minutes, 0);
    if (typeof service.active !== "boolean" || new Set(service.agenda_ids).size !== service.agenda_ids.length) throw new RangeError("invalid service");
    for (const id of service.agenda_ids) requireAgenda(agendaIds, id);
  }
  for (const override of input.overrides) {
    requireAgenda(agendaIds, override.agenda_id);
    if (localDate(override.date_to) < localDate(override.date_from)) throw new RangeError("invalid override dates");
    if (typeof override.closed !== "boolean" || (override.closed ? override.ranges.length !== 0 : override.ranges.length === 0)) throw new RangeError("invalid override ranges");
    validateRanges(override.ranges);
  }
  for (const agenda of input.agendas) {
    const overrides = input.overrides.filter((item) => item.agenda_id === agenda.id).sort((a, b) => compare(a.date_from, b.date_from));
    for (let i = 1; i < overrides.length; i++) {
      if (overrides[i]!.date_from <= overrides[i - 1]!.date_to) throw new RangeError("overlapping overrides");
    }
  }
  const busy = new Map<string, Interval[]>(input.agendas.map((agenda) => [agenda.id, []]));
  const workload = new Map<string, number>();
  for (const booking of input.bookings) {
    requireAgenda(agendaIds, booking.agenda_id);
    const interval = utcInterval(booking);
    integer(booking.buffer_before_minutes, 0); integer(booking.buffer_after_minutes, 0);
    if (!["held", "requested", "confirmed", "done", "cancelled", "no_show"].includes(booking.status)) throw new RangeError("invalid booking status");
    const expired = booking.status === "held" && booking.hold_expires_at !== undefined && utc(booking.hold_expires_at) <= now;
    if (expired || booking.status === "cancelled" || booking.status === "no_show") continue;
    const key = `${booking.agenda_id}/${clockParts(formatter, interval.start).date}`;
    workload.set(key, (workload.get(key) ?? 0) + 1);
    if (booking.status !== "done") busy.get(booking.agenda_id)!.push({
      start: interval.start - booking.buffer_before_minutes * MINUTE,
      end: interval.end + booking.buffer_after_minutes * MINUTE,
    });
  }
  for (const block of input.busy_blocks) {
    requireAgenda(agendaIds, block.agenda_id);
    busy.get(block.agenda_id)!.push(utcInterval(block));
  }
  const service = input.services.find((item) => item.id === input.service_id && item.active);
  const eligible = input.agendas.filter((agenda) => agenda.active && service?.agenda_ids.includes(agenda.id) && (input.agenda_id === "any" || input.agenda_id === agenda.id));
  const slots: SlotDays = { time_zone: input.time_zone, days: [] };
  const picks = new Map<number, string>();
  for (let day = from; day <= to; day += DAY) {
    const date = new Date(day).toISOString().slice(0, 10);
    const weekday = new Date(day).getUTCDay() || 7;
    const ordered = [...eligible].sort((a, b) =>
      (workload.get(`${a.id}/${date}`) ?? 0) - (workload.get(`${b.id}/${date}`) ?? 0) || a.sort - b.sort || compare(a.id, b.id));
    const available = ordered.map((agenda) => {
      const override = input.overrides.find((item) => item.agenda_id === agenda.id && item.date_from <= date && date <= item.date_to);
      const ranges = override ? (override.closed ? [] : override.ranges) : agenda.availability.filter((item) => item.weekday === weekday);
      return { agenda, ranges: ranges.map((range) => ({ start: wallTime(range.start), end: wallTime(range.end) })) };
    });
    const minutes = available.some((item) => item.ranges.length) ? clockMinutes(formatter, day, date) : [];
    const free = new Map<number, number>();
    for (const { agenda, ranges } of available) {
      const windows = openWindows(minutes, ranges);
      for (const { instant: start, minute } of minutes) {
        if (minute % step !== 0 || start < now + notice * MINUTE || start > now + horizon * DAY) continue;
        const end = start + service!.duration_minutes * MINUTE;
        const occupied = { start: start - service!.buffer_before_minutes * MINUTE, end: end + service!.buffer_after_minutes * MINUTE };
        if (!windows.some((window) => window.start <= occupied.start && occupied.end <= window.end)) continue;
        if (busy.get(agenda.id)!.some((block) => overlaps(occupied, block))) continue;
        // Ordered agendas make the first free one the deterministic hold-time recommendation.
        if (!free.has(start)) { free.set(start, end); picks.set(start, agenda.id); }
      }
    }
    slots.days.push({ date, slots: [...free].sort(([a], [b]) => a - b).map(([start, end]) => ({ start: new Date(start).toISOString(), end: new Date(end).toISOString() })) });
  }
  return { slots, picks };
}

function clockParts(formatter: Intl.DateTimeFormat, instant: number): { date: string; minute: number } {
  const parts = Object.fromEntries(formatter.formatToParts(instant).map(({ type, value }) => [type, value]));
  return { date: `${parts.year!.padStart(4, "0")}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

function clockMinutes(formatter: Intl.DateTimeFormat, day: number, date: string): ClockMinute[] {
  const result: ClockMinute[] = [];
  // Enumerate real UTC minutes, not a fixed offset or a 24-hour local day. A skipped minute
  // produces no candidate; both occurrences of a repeated minute retain distinct UTC instants.
  for (let instant = day - DAY; instant < day + 2 * DAY; instant += MINUTE) {
    const local = clockParts(formatter, instant);
    if (local.date === date) result.push({ instant, minute: local.minute });
  }
  return result;
}

function openWindows(minutes: ClockMinute[], ranges: Interval[]): Interval[] {
  const windows: Interval[] = [];
  for (const { instant, minute } of minutes) {
    if (!ranges.some((range) => range.start <= minute && minute < range.end)) continue;
    const last = windows.at(-1);
    if (last?.end === instant) last.end += MINUTE;
    else windows.push({ start: instant, end: instant + MINUTE });
  }
  return windows;
}

function validateRanges(ranges: TimeRange[]): void {
  const sorted = ranges.map((range) => ({ start: wallTime(range.start), end: wallTime(range.end) })).sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i]!.end <= sorted[i]!.start || (i > 0 && sorted[i]!.start < sorted[i - 1]!.end)) throw new RangeError("overlapping or reversed hours");
  }
}

function wallTime(value: string): number {
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value)) throw new RangeError("invalid local time");
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}

function localDate(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError("invalid local date");
  const instant = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(instant) || new Date(instant).toISOString().slice(0, 10) !== value) throw new RangeError("invalid local date");
  return instant;
}

function utc(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)) throw new RangeError("invalid UTC instant");
  const instant = Date.parse(value);
  if (!Number.isFinite(instant) || new Date(instant).toISOString().replace(".000Z", "Z") !== value.replace(".000Z", "Z")) throw new RangeError("invalid UTC instant");
  return instant;
}

function utcInterval(value: { start: string; end: string }): Interval {
  const interval = { start: utc(value.start), end: utc(value.end) };
  if (interval.end <= interval.start) throw new RangeError("invalid busy interval");
  return interval;
}

function integer(value: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError("invalid scheduling integer");
}

function uniqueIds(values: { id: string }[]): Set<string> {
  const ids = new Set(values.map(({ id }) => id));
  if (ids.size !== values.length || values.some(({ id }) => typeof id !== "string" || !id || id === "any")) throw new RangeError("invalid or duplicate scheduling ID");
  return ids;
}

function requireAgenda(ids: Set<string>, id: string): void {
  if (!ids.has(id)) throw new RangeError("unknown agenda reference");
}

function overlaps(a: Interval, b: Interval): boolean { return a.start < b.end && b.start < a.end; }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
