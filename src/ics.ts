// A small iCalendar reader and writer (RFC 5545) for the Agenda's external calendars (ADR 0101, bipe#319). The reader
// keeps start and end only, never titles or descriptions. It expands RRULE and EXDATE inside the given window.

export type BusyInterval = { start: number; end: number };

const DAY_MS = 86_400_000;
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const MAX_OCCURRENCES = 2000;

type Prop = { name: string; params: Record<string, string>; value: string };

function unfold(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

function parseLine(line: string): Prop | undefined {
  const colon = line.indexOf(":");
  if (colon <= 0) return undefined;
  const [name, ...params] = line.slice(0, colon).split(";");
  return {
    name: name!.toUpperCase(),
    params: Object.fromEntries(params.map((p) => {
      const eq = p.indexOf("=");
      return [p.slice(0, eq).toUpperCase(), p.slice(eq + 1).replace(/^"|"$/g, "")];
    })),
    value: line.slice(colon + 1).trim(),
  };
}

/** The UTC instant of a wall time in an IANA zone. Offset at that instant, corrected once for a DST edge. */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, zone: string): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const offset = (at: number) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
      }).formatToParts(at).map((p) => [p.type, p.value]),
    );
    return Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!) - at;
  };
  const first = wall - offset(wall);
  return wall - offset(first);
}

function validZone(zone: string | undefined): zone is string {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** A DATE or DATE-TIME value. An all-day date, or a floating time, reads in `fallbackZone`. */
function parseTime(prop: Prop, fallbackZone: string): number | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(prop.value);
  if (!m) return undefined;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4] ?? "0", m[5] ?? "0", m[6] ?? "0"].map(Number) as [number, number, number, number, number, number];
  if (m[7]) return Date.UTC(y, mo - 1, d, h, mi, s);
  return zonedToUtc(y, mo, d, h, mi, s, validZone(prop.params.TZID) ? prop.params.TZID : fallbackZone);
}

function parseDuration(value: string): number | undefined {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!m || m[1] === "-") return undefined;
  return (+(m[2] ?? 0) * 7 * DAY_MS) + (+(m[3] ?? 0) * DAY_MS) + (+(m[4] ?? 0) * 3_600_000) + (+(m[5] ?? 0) * 60_000) + (+(m[6] ?? 0) * 1000);
}

function occurrences(start: number, rule: string, window: BusyInterval, zone: string): number[] {
  const parts = Object.fromEntries(rule.split(";").map((p) => {
    const eq = p.indexOf("=");
    return [p.slice(0, eq).toUpperCase(), p.slice(eq + 1)];
  })) as Record<string, string>;
  const interval = Math.max(1, Number(parts.INTERVAL) || 1);
  const count = parts.COUNT ? Number(parts.COUNT) : undefined;
  const until = parts.UNTIL ? parseTime({ name: "UNTIL", params: {}, value: parts.UNTIL }, zone) : undefined;
  const byDay = parts.BYDAY ? parts.BYDAY.split(",").map((d) => d.slice(-2)) : undefined;
  const out: number[] = [];
  let seen = 0;
  const take = (at: number): boolean => {
    if (at < start) return true;
    if ((count !== undefined && seen >= count) || (until !== undefined && at > until) || at > window.end) return false;
    seen++;
    if (out.length < MAX_OCCURRENCES) out.push(at);
    return true;
  };
  const date = new Date(start);
  switch (parts.FREQ) {
    case "DAILY":
      for (let i = 0; i < 40_000; i++) {
        const at = start + i * interval * DAY_MS;
        if (byDay && !byDay.includes(WEEKDAYS[new Date(at).getUTCDay()]!)) continue;
        if (!take(at)) break;
      }
      break;
    case "WEEKLY": {
      const days = byDay ?? [WEEKDAYS[date.getUTCDay()]!];
      const weekStart = start - date.getUTCDay() * DAY_MS;
      outer: for (let w = 0; w < 6000; w++) {
        for (let d = 0; d < 7; d++) {
          if (!days.includes(WEEKDAYS[d]!)) continue;
          if (!take(weekStart + (w * interval * 7 + d) * DAY_MS)) break outer;
        }
      }
      break;
    }
    case "MONTHLY":
      for (let i = 0; i < 2400; i++) {
        const at = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + i * interval, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds());
        if (new Date(at).getUTCDate() !== date.getUTCDate()) continue;
        if (!take(at)) break;
      }
      break;
    case "YEARLY":
      for (let i = 0; i < 200; i++) {
        const at = Date.UTC(date.getUTCFullYear() + i * interval, date.getUTCMonth(), date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds());
        if (new Date(at).getUTCMonth() !== date.getUTCMonth()) continue;
        if (!take(at)) break;
      }
      break;
    default:
      return [start];
  }
  return out;
}

/** The busy intervals of a calendar that touch `window`. Free and cancelled events do not count. */
export function parseBusy(text: string, window: BusyInterval, zone: string): BusyInterval[] {
  const out: BusyInterval[] = [];
  let event: Prop[] | undefined;
  for (const line of unfold(text)) {
    if (line === "BEGIN:VEVENT") event = [];
    else if (line === "END:VEVENT" && event) {
      out.push(...eventBusy(event, window, zone));
      event = undefined;
    } else if (event) {
      const prop = parseLine(line);
      if (prop) event.push(prop);
    }
  }
  return out;
}

function eventBusy(props: Prop[], window: BusyInterval, zone: string): BusyInterval[] {
  const get = (name: string) => props.find((p) => p.name === name);
  if (get("STATUS")?.value.toUpperCase() === "CANCELLED" || get("TRANSP")?.value.toUpperCase() === "TRANSPARENT") return [];
  const startProp = get("DTSTART");
  const start = startProp && parseTime(startProp, zone);
  if (start === undefined) return [];
  const endProp = get("DTEND");
  const durationProp = get("DURATION");
  const end = endProp ? parseTime(endProp, zone) : undefined;
  const allDay = startProp!.params.VALUE === "DATE" || /^\d{8}$/.test(startProp!.value);
  const length = end !== undefined ? end - start : durationProp ? parseDuration(durationProp.value) : allDay ? DAY_MS : 0;
  if (!length || length <= 0) return [];
  const excluded = new Set(
    props.filter((p) => p.name === "EXDATE").flatMap((p) => p.value.split(",").map((v) => parseTime({ ...p, value: v }, zone))),
  );
  const rule = get("RRULE");
  const starts = rule ? occurrences(start, rule.value, window, zone) : [start];
  return starts
    .filter((at) => !excluded.has(at) && at < window.end && at + length > window.start)
    .map((at) => ({ start: at, end: at + length }));
}

const escapeText = (text: string) => text.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const utc = (iso: Date) => iso.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/** A calendar of bookings. `summary` is Agendado, or the first name when the owner turned it on. */
export function writeFeed(events: { id: string; start: Date; end: Date; summary: string; cancelled: boolean }[], now = new Date()): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Bipe//Agenda//PT",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...events.flatMap((e) => [
      "BEGIN:VEVENT",
      `UID:${escapeText(e.id)}@bipe.chat`,
      `DTSTAMP:${utc(now)}`,
      `DTSTART:${utc(e.start)}`,
      `DTEND:${utc(e.end)}`,
      `SUMMARY:${escapeText(e.summary)}`,
      ...(e.cancelled ? ["STATUS:CANCELLED"] : []),
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}
