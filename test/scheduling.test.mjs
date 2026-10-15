import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { calculateSlots, selectAgenda } from "../dist/scheduling.js";

const document = JSON.parse(readFileSync(new URL("./fixtures/scheduling.json", import.meta.url), "utf8"));
assert.equal(document.version, 1);
assert.match(document.source_sha256, /^[0-9a-f]{64}$/);

function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

for (const vector of document.vectors) {
  test(`shared scheduling: ${vector.name} — ${vector.description}`, () => {
    const input = freeze(structuredClone(vector.input));
    assert.deepEqual(calculateSlots(input), vector.expected.slots);
    for (const pick of vector.expected.picks) assert.equal(selectAgenda(input, pick.start), pick.agenda_id);
  });
}

test("agenda and rule input ordering cannot change free slots or the fixed tie-break", () => {
  const vector = document.vectors.find((item) => item.name === "any-fixed-id");
  const input = structuredClone(vector.input);
  const before = calculateSlots(input);
  input.agendas.reverse();
  input.services.reverse();
  for (const agenda of input.agendas) agenda.availability.reverse();
  assert.deepEqual(calculateSlots(input), before);
  assert.equal(selectAgenda(input, vector.expected.picks[0].start), "a");
});

test("a fresh busy snapshot can invalidate a previous any-person recommendation", () => {
  const input = structuredClone(document.vectors.find((item) => item.name === "any-fixed-id").input);
  const start = "2026-10-16T12:00:00Z";
  assert.equal(selectAgenda(input, start), "a");
  input.busy_blocks.push({ agenda_id: "a", start, end: "2026-10-16T12:30:00Z" });
  assert.equal(selectAgenda(input, start), "b");
  input.busy_blocks.push({ agenda_id: "b", start, end: "2026-10-16T12:30:00Z" });
  assert.equal(selectAgenda(input, start), null);
});

test("adding busy time cannot create a public slot", () => {
  const input = structuredClone(document.vectors[0].input);
  const before = new Set(calculateSlots(input).days.flatMap((day) => day.slots.map((slot) => slot.start)));
  input.busy_blocks.push({ agenda_id: "a", start: "2026-10-16T12:07:00Z", end: "2026-10-16T13:11:00Z" });
  for (const day of calculateSlots(input).days) for (const slot of day.slots) assert.ok(before.has(slot.start));
});

const invalid = [
  ["zero slot step", (input) => { input.policy.slot_step_minutes = 0; }],
  ["non-finite policy", (input) => { input.policy.horizon_days = Infinity; }],
  ["fractional buffer", (input) => { input.services[0].buffer_after_minutes = 0.5; }],
  ["negative duration", (input) => { input.services[0].duration_minutes = -1; }],
  ["invalid time zone", (input) => { input.time_zone = "Not/A_Zone"; }],
  ["missing time zone", (input) => { delete input.time_zone; }],
  ["fixed offset instead of an IANA zone", (input) => { input.time_zone = "+03:00"; }],
  ["invalid calendar date", (input) => { input.date_from = "2026-02-30"; }],
  ["reversed date range", (input) => { input.date_to = "2026-10-15"; }],
  ["unbounded calculation", (input) => { input.date_to = "2030-01-01"; }],
  ["local time instead of UTC", (input) => { input.now = "2026-10-15T09:00:00-03:00"; }],
  ["invalid weekday", (input) => { input.agendas[0].availability[0].weekday = 8; }],
  ["overlapping hours", (input) => { input.agendas[0].availability.push({ weekday: 5, start: "10:00", end: "12:00" }); }],
  ["reversed hours", (input) => { input.agendas[0].availability[0].end = "08:00"; }],
  ["invalid wall time", (input) => { input.agendas[0].availability[0].start = "25:00"; }],
  ["duplicate agenda IDs", (input) => { input.agendas.push(structuredClone(input.agendas[0])); }],
  ["unknown agenda reference", (input) => { input.services[0].agenda_ids.push("missing"); }],
  ["unknown booking status", (input) => { input.bookings.push({ agenda_id: "a", start: "2026-10-16T12:00:00Z", end: "2026-10-16T12:30:00Z", status: "unknown", buffer_before_minutes: 0, buffer_after_minutes: 0 }); }],
  ["reversed busy interval", (input) => { input.busy_blocks.push({ agenda_id: "a", start: "2026-10-16T13:00:00Z", end: "2026-10-16T12:00:00Z" }); }],
  ["overlapping overrides", (input) => { input.overrides.push(...Array.from({ length: 2 }, () => ({ agenda_id: "a", date_from: "2026-10-16", date_to: "2026-10-17", closed: true, ranges: [] }))); }],
  ["closed override with hours", (input) => { input.overrides.push({ agenda_id: "a", date_from: "2026-10-16", date_to: "2026-10-16", closed: true, ranges: [{ start: "09:00", end: "10:00" }] }); }],
];
for (const [name, change] of invalid) {
  test(`scheduling refuses ${name}`, () => {
    const input = structuredClone(document.vectors[0].input);
    change(input);
    assert.throws(() => calculateSlots(input), RangeError);
  });
}
