import assert from "node:assert/strict";
import { test } from "node:test";
import * as agenda from "../dist/agenda.js";
import * as catalog from "../dist/catalog.js";
import { isolatedDatabase } from "./helpers/database.mjs";

// bipe#318, bipe#328: Catálogo and Agenda against a real Postgres. Synthetic IDs only.
const shop = "@shop:example.test";
const ana = "@ana:example.test";
const bia = "@bia:example.test";
const API = "https://api.example.test";

async function setup(t) {
  const db = await isolatedDatabase(t);
  await db.query("INSERT INTO signups (user_id, account_type) VALUES ($1, 'company'), ($2, 'personal'), ($3, 'personal')", [shop, ana, bia]);
  await db.query("INSERT INTO handles (user_id, handle, skeleton) VALUES ($1, 'loja', 'loja')", [shop]);
  return db;
}

/** Activated, open every day 00:00 to 23:45 UTC, published. Returns the service and the agenda. */
async function openShop(db) {
  const state = await agenda.activate(db, API, shop, { template_id: "barbershop", time_zone: "UTC" });
  const agendaId = state.agendas[0].id;
  await agenda.setAvailability(db, shop, agendaId, { rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: "00:00", end: "23:45" })) });
  await agenda.setPolicy(db, shop, { ...state.policy, min_notice_minutes: 0 });
  await agenda.saveSettings(db, API, shop, { published: true, time_zone: "UTC" });
  return { service: state.services[0], agendaId };
}

const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

async function firstSlot(db, serviceId) {
  const day = tomorrow();
  const result = await agenda.slots(db, shop, { service_id: serviceId, agenda_id: "any", date_from: day, date_to: day });
  return result.days[0].slots[0].start;
}

async function rejects(promise, id) {
  await assert.rejects(promise, (e) => e.id === id || assert.fail(`expected ${id}, got ${e.id ?? e.message}`));
}

test("activation makes one agenda and the template services as catalogue items, once", async (t) => {
  const db = await setup(t);
  await rejects(agenda.agendaState(db, API, shop), "not_found");
  const first = await agenda.activate(db, API, shop, { template_id: "barbershop" });
  assert.equal(first.agendas.length, 1);
  assert.equal(first.agendas[0].name, "loja");
  assert.equal(first.published, false);
  assert.equal(first.time_zone, "America/Sao_Paulo");
  assert.deepEqual(first.services.map((s) => s.name), ["Corte", "Barba"]);
  assert.ok(first.services.every((s) => s.kind === "service" && s.agenda_ids[0] === first.agendas[0].id));
  const again = await agenda.activate(db, API, shop, { template_id: "salon" });
  assert.equal(again.agendas.length, 1);
  assert.equal(again.services.length, 2);
  const items = await catalog.ownerCatalog(db, API, shop);
  assert.equal(items.items.length, 2, "services are the catalogue's items, not a second table");
  await rejects(agenda.activate(db, API, ana, { template_id: "nope" }), "bad_request");
});

test("catalogue items: create, replace, reorder, archive; products refuse scheduling fields", async (t) => {
  const db = await setup(t);
  const bread = await catalog.createItem(db, API, shop, { kind: "product", name: "Pão", price: { mode: "fixed", text: "R$ 1", amount_cents: 100 }, active: true, sort: 0 });
  const cake = await catalog.createItem(db, API, shop, { kind: "product", name: "Bolo", price: { mode: "on_request" }, active: true, sort: 1, sold_out_today: true });
  assert.equal(cake.sold_out_today, true);
  assert.equal(bread.sold_out_today, false);
  assert.equal(catalog.CatalogItemBody.safeParse({ kind: "product", name: "x", price: { mode: "on_request" }, active: true, sort: 0, duration_minutes: 10 }).success, false);
  const hidden = await catalog.replaceItem(db, API, shop, bread.id, { kind: "product", name: "Pão", price: { mode: "from", text: "R$ 1" }, active: false, sort: 0 });
  assert.equal(hidden.active, false);
  assert.deepEqual((await catalog.publicCatalog(db, API, shop)).items.map((i) => i.name), ["Bolo"]);
  const reordered = await catalog.reorder(db, API, shop, [cake.id]);
  assert.deepEqual(reordered.items.map((i) => i.name), ["Bolo", "Pão"]);
  await catalog.archiveItem(db, shop, cake.id);
  assert.deepEqual((await catalog.ownerCatalog(db, API, shop)).items.map((i) => i.name), ["Pão"]);
  await rejects(catalog.replaceItem(db, API, bia, bread.id, { kind: "product", name: "x", price: { mode: "on_request" }, active: true, sort: 0 }), "not_found");
});

test("a customer holds a free time, confirms it, and sees it in their bookings", async (t) => {
  const db = await setup(t);
  const { service } = await openShop(db);
  const start = await firstSlot(db, service.id);
  const held = await agenda.hold(db, shop, ana, { service_id: service.id, agenda_id: "any", start });
  assert.equal(held.status, "held");
  assert.ok(held.hold_expires_at);
  assert.deepEqual(held.customer, { user_id: ana });
  const after = await agenda.slots(db, shop, { service_id: service.id, agenda_id: "any", date_from: tomorrow(), date_to: tomorrow() });
  assert.ok(!after.days[0].slots.some((s) => s.start === start), "a held time is not free");
  const confirmed = await agenda.confirm(db, shop, ana, held.id);
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.hold_expires_at, undefined);
  assert.deepEqual((await agenda.myBookings(db, ana)).bookings.map((b) => b.id), [held.id]);
  assert.deepEqual((await agenda.myBookings(db, shop)).bookings.map((b) => b.id), [held.id]);
  assert.deepEqual((await agenda.myBookings(db, bia)).bookings, []);
  await rejects(agenda.confirm(db, shop, bia, held.id), "not_found");
});

test("two holds on one time at once: one gets it, the other gets slot_taken", async (t) => {
  const db = await setup(t);
  const { service, agendaId } = await openShop(db);
  const start = await firstSlot(db, service.id);
  const results = await Promise.allSettled([
    agenda.hold(db, shop, ana, { service_id: service.id, agenda_id: agendaId, start }),
    agenda.hold(db, shop, bia, { service_id: service.id, agenda_id: agendaId, start }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.id, "slot_taken");
});

test("the database refuses an overlap even when the code is bypassed", async (t) => {
  const db = await setup(t);
  const { service } = await openShop(db);
  const start = await firstSlot(db, service.id);
  const booking = await agenda.hold(db, shop, ana, { service_id: service.id, agenda_id: "any", start });
  await assert.rejects(
    db.query(
      `INSERT INTO bookings (id, business_id, service_id, agenda_id, agenda_seq, start_at, end_at, busy_start, busy_end, buffer_before_minutes,
         buffer_after_minutes, status, customer_name, source)
       SELECT 'x', business_id, service_id, agenda_id, agenda_seq, start_at, end_at, busy_start, busy_end, 0, 0, 'confirmed', 'Zé', 'owner'
       FROM bookings WHERE id = $1`,
      [booking.id],
    ),
    (e) => e.code === "23P01",
  );
});

test("an expired hold cannot be confirmed and frees the time", async (t) => {
  const db = await setup(t);
  const { service } = await openShop(db);
  const start = await firstSlot(db, service.id);
  const held = await agenda.hold(db, shop, ana, { service_id: service.id, agenda_id: "any", start });
  await db.query("UPDATE bookings SET hold_expires_at = now() - interval '1 second' WHERE id = $1", [held.id]);
  await rejects(agenda.confirm(db, shop, ana, held.id), "hold_expired");
  const again = await agenda.hold(db, shop, bia, { service_id: service.id, agenda_id: "any", start });
  assert.equal(again.status, "held");
});

test("open bookings per customer are capped, and notice and horizon are enforced", async (t) => {
  const db = await setup(t);
  const { service } = await openShop(db);
  const day = await agenda.slots(db, shop, { service_id: service.id, agenda_id: "any", date_from: tomorrow(), date_to: tomorrow() });
  const [a, b, c] = day.days[0].slots.filter((_, i) => i % 8 === 0);
  await agenda.hold(db, shop, ana, { service_id: service.id, agenda_id: "any", start: a.start });
  await agenda.hold(db, shop, ana, { service_id: service.id, agenda_id: "any", start: b.start });
  await rejects(agenda.hold(db, shop, ana, { service_id: service.id, agenda_id: "any", start: c.start }), "too_many_open_bookings");
  const far = new Date(Date.now() + 400 * 86_400_000).toISOString();
  await rejects(agenda.hold(db, shop, bia, { service_id: service.id, agenda_id: "any", start: far }), "outside_horizon");
  await rejects(agenda.hold(db, shop, shop, { service_id: service.id, agenda_id: "any", start: c.start }), "bad_request");
});

test("unpublished agendas take no bookings", async (t) => {
  const db = await setup(t);
  const { service } = await openShop(db);
  await agenda.saveSettings(db, API, shop, { published: false, time_zone: "UTC" });
  await rejects(agenda.publicServices(db, API, shop), "agenda_not_published");
  await rejects(agenda.hold(db, shop, ana, { service_id: service.id, agenda_id: "any", start: new Date(Date.now() + 86_400_000).toISOString() }), "agenda_not_published");
});

test("cancel and move follow the cancellation window; a failed move keeps the booking", async (t) => {
  const db = await setup(t);
  const { service } = await openShop(db);
  const day = await agenda.slots(db, shop, { service_id: service.id, agenda_id: "any", date_from: tomorrow(), date_to: tomorrow() });
  const [first, second] = [day.days[0].slots[0], day.days[0].slots[8]];
  const mine = await agenda.confirm(db, shop, ana, (await agenda.hold(db, shop, ana, { service_id: service.id, agenda_id: "any", start: first.start })).id);
  const theirs = await agenda.confirm(db, shop, bia, (await agenda.hold(db, shop, bia, { service_id: service.id, agenda_id: "any", start: second.start })).id);
  await rejects(agenda.customerMove(db, shop, ana, mine.id, { agenda_id: "any", start: second.start }), "slot_taken");
  const kept = (await agenda.myBookings(db, ana)).bookings[0];
  assert.equal(kept.start, mine.start);
  const moved = await agenda.customerMove(db, shop, ana, mine.id, { agenda_id: "any", start: day.days[0].slots[16].start });
  assert.equal(moved.start, day.days[0].slots[16].start);
  await db.query("UPDATE bookings SET start_at = now() + interval '30 minutes', end_at = now() + interval '60 minutes', busy_start = now() + interval '30 minutes', busy_end = now() + interval '60 minutes' WHERE id = $1", [theirs.id]);
  await rejects(agenda.customerCancel(db, shop, bia, theirs.id), "cancellation_window_closed");
  const cancelled = await agenda.customerCancel(db, shop, ana, mine.id);
  assert.equal(cancelled.status, "cancelled");
});

test("owner: encaixe by name, move, cancel, and the owner day list", async (t) => {
  const db = await setup(t);
  const { service, agendaId } = await openShop(db);
  const start = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10) + "T10:00:00.000Z";
  const walkIn = await agenda.ownerBook(db, shop, { service_id: service.id, agenda_id: agendaId, start, customer: { name: "Zé" } });
  assert.deepEqual(walkIn.customer, { name: "Zé" });
  assert.equal(walkIn.source, "owner");
  assert.equal(walkIn.status, "confirmed");
  await rejects(agenda.ownerBook(db, shop, { service_id: service.id, agenda_id: agendaId, start, customer: { name: "Outro" } }), "slot_taken");
  const later = start.replace("T10:00", "T14:00");
  const moved = await agenda.ownerMove(db, shop, walkIn.id, { agenda_id: agendaId, start: later });
  assert.equal(moved.start, later);
  const list = await agenda.ownerBookings(db, shop, { date_from: start.slice(0, 10), date_to: start.slice(0, 10) });
  assert.deepEqual(list.bookings.map((b) => b.id), [walkIn.id]);
  assert.equal((await agenda.ownerAction(db, shop, walkIn.id, "cancel")).status, "cancelled");
  await rejects(agenda.ownerAction(db, shop, walkIn.id, "no-show"), "bad_request");
});

test("block subtracts a time from one day; close day closes it; overlapping overrides are refused", async (t) => {
  const db = await setup(t);
  const { service, agendaId } = await openShop(db);
  const day = tomorrow();
  const blocked = await agenda.block(db, shop, { agenda_ids: [agendaId], start: `${day}T12:00:00.000Z`, end: `${day}T13:00:00.000Z` });
  assert.deepEqual(blocked.ranges, [{ start: "00:00", end: "12:00" }, { start: "13:00", end: "23:45" }]);
  const slots = await agenda.slots(db, shop, { service_id: service.id, agenda_id: "any", date_from: day, date_to: day });
  assert.ok(!slots.days[0].slots.some((s) => s.start === `${day}T12:00:00.000Z`));
  const closed = await agenda.closeDay(db, shop, { agenda_ids: [agendaId], date: day });
  assert.equal(closed.closed, true);
  const none = await agenda.slots(db, shop, { service_id: service.id, agenda_id: "any", date_from: day, date_to: day });
  assert.deepEqual(none.days[0].slots, []);
  assert.equal((await agenda.listOverrides(db, shop)).overrides.length, 1);
  await rejects(agenda.createOverride(db, shop, { agenda_id: agendaId, date_from: day, date_to: day, closed: true, ranges: [] }), "bad_request");
});

test("publishing needs an active service on an agenda with hours", async (t) => {
  const db = await setup(t);
  const state = await agenda.activate(db, API, shop, { template_id: "other" });
  await agenda.setAvailability(db, shop, state.agendas[0].id, { rules: [] });
  await rejects(agenda.saveSettings(db, API, shop, { published: true, time_zone: "America/Sao_Paulo" }), "bad_request");
});

test("housekeeping marks past bookings done and prunes old ones", async (t) => {
  const db = await setup(t);
  const { service, agendaId } = await openShop(db);
  const booking = await agenda.ownerBook(db, shop, { service_id: service.id, agenda_id: agendaId, start: new Date(Date.now() + 86_400_000).toISOString(), customer: { user_id: ana } });
  await db.query("UPDATE bookings SET start_at = now() - interval '3 hours', end_at = now() - interval '2 hours', busy_start = now() - interval '3 hours', busy_end = now() - interval '2 hours' WHERE id = $1", [booking.id]);
  const first = await agenda.agendaHousekeeping(db);
  assert.equal(first.done, 1);
  await db.query("UPDATE bookings SET end_at = now() - interval '731 days', start_at = now() - interval '732 days', busy_start = now() - interval '732 days', busy_end = now() - interval '731 days' WHERE id = $1", [booking.id]);
  assert.equal((await agenda.agendaHousekeeping(db)).pruned, 1);
});

test("routes: owner routes need the company account; the public catalogue and slots need no token", async (t) => {
  const db = await setup(t);
  const { businessRoutes } = await import("../dist/business-routes.js");
  const auth = { userId: async (h) => { if (!h) throw Object.assign(new Error("unauthorized"), { id: "unauthorized" }); return h.slice(7); } };
  const app = businessRoutes({ db, auth, apiUrl: API, siteUrl: "https://site.example.test", clientIp: () => "127.0.0.1" });
  app.onError((err, c) => c.json(err.body ? err.body() : { error: "internal" }, err.status ?? 500));
  const call = (method, path, user, body) =>
    app.request(path, { method, headers: { ...(user ? { authorization: `Bearer ${user}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body && JSON.stringify(body) });
  assert.equal((await call("GET", "/v1/me/business/catalog", ana)).status, 404);
  assert.equal((await call("POST", "/v1/me/business/agenda/activate", shop, { template_id: "barbershop", time_zone: "UTC" })).status, 201);
  const catalogue = await (await call("GET", "/v1/businesses/loja/catalog")).json();
  assert.equal(catalogue.items.length, 2);
  assert.equal((await call("GET", `/v1/businesses/${encodeURIComponent(shop)}/catalog`)).status, 200);
  assert.equal((await call("GET", "/v1/businesses/nobody/catalog")).status, 404);
  const slots = await call("GET", `/v1/businesses/loja/agenda/slots?service_id=${catalogue.items[0].id}&date_from=2030-01-01&date_to=2030-01-07`);
  assert.equal(slots.status, 422);
  assert.equal((await slots.json()).error, "agenda_not_published");
  assert.equal((await call("POST", "/v1/me/business/catalog/items", shop, { kind: "product", name: "x", price: { mode: "on_request" }, active: true, sort: 0, agenda_ids: ["a"] })).status, 400);
});
