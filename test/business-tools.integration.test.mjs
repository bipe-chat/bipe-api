import assert from "node:assert/strict";
import { test } from "node:test";
import * as agenda from "../dist/agenda.js";
import * as catalog from "../dist/catalog.js";
import * as orders from "../dist/orders.js";
import * as queue from "../dist/queue.js";
import * as quotes from "../dist/quotes.js";
import { isolatedDatabase } from "./helpers/database.mjs";

// bipe#333, bipe#337, bipe#341: Fila virtual, Orçamento and Pedidos against a real Postgres. Synthetic IDs only.
const shop = "@shop:example.test";
const ana = "@ana:example.test";
const bia = "@bia:example.test";
const API = "https://api.example.test";

async function setup(t) {
  const db = await isolatedDatabase(t);
  await db.query("INSERT INTO signups (user_id, account_type) VALUES ($1, 'company'), ($2, 'personal'), ($3, 'personal')", [shop, ana, bia]);
  return db;
}

async function rejects(promise, id) {
  await assert.rejects(promise, (e) => e.id === id || assert.fail(`expected ${id}, got ${e.id ?? e.message}`));
}

const product = (name, price, extra = {}) => ({ kind: "product", name, price, active: true, sort: 0, ...extra });

test("queue: join, position, call, served, one place per customer, closed queue", async (t) => {
  const db = await setup(t);
  await rejects(queue.join(db, shop, ana, {}), "queue_closed");
  const opened = await queue.setOpen(db, shop, true);
  assert.equal(opened.open, true);
  assert.equal(opened.policy.no_show_after_minutes, 10);
  const first = await queue.join(db, shop, ana, {});
  assert.equal(first.position, 1);
  assert.equal(first.wait, undefined, "no data, no estimate");
  await rejects(queue.join(db, shop, ana, {}), "already_in_queue");
  const walkIn = await queue.addPlace(db, shop, { customer: { name: "Zé" } });
  assert.deepEqual(walkIn.customer, { name: "Zé" });
  const second = await queue.join(db, shop, bia, {});
  assert.equal(second.position, 3);
  const called = await queue.callNext(db, shop);
  assert.equal(called.customer.user_id, ana);
  assert.equal((await queue.myPlace(db, shop, ana)).position, 0);
  assert.equal((await queue.myPlace(db, shop, bia)).position, 2);
  await db.query("UPDATE queue_places SET called_at = now() - interval '20 minutes' WHERE id = $1", [called.id]);
  await queue.placeAction(db, shop, called.id, "served");
  const estimate = await queue.myPlace(db, shop, bia);
  assert.ok(estimate.wait && estimate.wait.max_minutes >= estimate.wait.min_minutes && estimate.wait.max_minutes > 0);
  assert.equal((await queue.myPlaces(db, bia)).places.length, 1);
  assert.equal((await queue.myPlaces(db, shop)).places.length, 2);
  const left = await queue.leave(db, shop, bia, second.place.id);
  assert.equal(left.place.status, "left");
  await rejects(queue.leave(db, shop, bia, second.place.id), "place_not_active");
  await queue.setOpen(db, shop, false);
  await rejects(queue.join(db, shop, bia, {}), "queue_closed");
});

test("queue: a called place past its window becomes no-show; recall calls it again", async (t) => {
  const db = await setup(t);
  await queue.setOpen(db, shop, true);
  await queue.setPolicy(db, shop, { no_show_after_minutes: 5 });
  await queue.join(db, shop, ana, {});
  const called = await queue.callNext(db, shop);
  await db.query("UPDATE queue_places SET called_at = now() - interval '6 minutes' WHERE id = $1", [called.id]);
  const places = await queue.ownerPlaces(db, shop);
  assert.equal(places.places[0].status, "no_show");
  assert.equal((await queue.placeAction(db, shop, called.id, "recall")).status, "called");
  await rejects(queue.callNext(db, shop), "not_found");
});

test("orders: fixed-price products only, server totals, one open order, transitions", async (t) => {
  const db = await setup(t);
  const bread = await catalog.createItem(db, API, shop, product("Pão", { mode: "fixed", text: "R$ 1,50", amount_cents: 150 }));
  const cake = await catalog.createItem(db, API, shop, product("Bolo", { mode: "on_request" }));
  const pie = await catalog.createItem(db, API, shop, product("Torta", { mode: "fixed", text: "R$ 30", amount_cents: 3000 }, { sold_out_today: true }));
  await rejects(orders.placeOrder(db, shop, ana, { lines: [{ item_id: cake.id, quantity: 1 }], fulfilment: "pickup", payment: "in_person" }), "price_not_fixed");
  await rejects(orders.placeOrder(db, shop, ana, { lines: [{ item_id: pie.id, quantity: 1 }], fulfilment: "pickup", payment: "in_person" }), "item_unavailable");
  await rejects(orders.placeOrder(db, shop, ana, { lines: [{ item_id: bread.id, quantity: 1 }], fulfilment: "pickup", payment: "pix" }), "payment_requires_verified_business");
  const order = await orders.placeOrder(db, shop, ana, { lines: [{ item_id: bread.id, quantity: 4 }, { item_id: bread.id, quantity: 2 }], fulfilment: "delivery", payment: "in_person" });
  assert.equal(order.status, "sent");
  assert.equal(order.total_amount_cents, 900);
  assert.deepEqual(order.lines, [{ item_id: bread.id, name: "Pão", quantity: 6, unit_amount_cents: 150, total_amount_cents: 900 }]);
  await rejects(orders.placeOrder(db, shop, ana, { lines: [{ item_id: bread.id, quantity: 1 }], fulfilment: "pickup", payment: "in_person" }), "order_already_open");
  await rejects(orders.ownerTransition(db, shop, order.id, "ready"), "order_not_open");
  assert.equal((await orders.ownerTransition(db, shop, order.id, "accept")).status, "accepted");
  assert.equal((await orders.ownerTransition(db, shop, order.id, "ready")).status, "ready");
  assert.equal((await orders.ownerTransition(db, shop, order.id, "done")).status, "done");
  await rejects(orders.customerCancel(db, shop, ana, order.id), "order_not_open");
  const next = await orders.placeOrder(db, shop, ana, { lines: [{ item_id: bread.id, quantity: 1 }], fulfilment: "pickup", payment: "in_person" });
  const refused = await orders.ownerTransition(db, shop, next.id, "refuse", "closed");
  assert.equal(refused.refuse_reason, "closed");
  assert.equal((await orders.myOrders(db, ana)).orders.length, 2);
  assert.equal((await orders.myOrders(db, shop)).orders.length, 2);
  assert.equal((await orders.myOrders(db, bia)).orders.length, 0);
  await rejects(orders.customerGet(db, shop, bia, next.id), "not_found");
});

test("orders: the policy closes days and the cut-off; the owner enters a name-only order", async (t) => {
  const db = await setup(t);
  const bread = await catalog.createItem(db, API, shop, product("Pão", { mode: "fixed", text: "R$ 1", amount_cents: 100 }));
  await orders.setPolicy(db, shop, { time_zone: "UTC", weekdays: [], cutoff: "16:00" });
  await rejects(orders.placeOrder(db, shop, ana, { lines: [{ item_id: bread.id, quantity: 1 }], fulfilment: "pickup", payment: "in_person" }), "orders_closed");
  const owner = await orders.ownerOrder(db, shop, { lines: [{ item_id: bread.id, quantity: 2 }], fulfilment: "pickup", payment: "in_person", customer: { name: "Zé" } });
  assert.deepEqual(owner.customer, { name: "Zé" });
  assert.equal(owner.source, "owner");
  assert.deepEqual((await orders.policyOf(db, shop)).weekdays, []);
});

test("quotes: request, answer, revise, version check, refuse", async (t) => {
  const db = await setup(t);
  const request = await quotes.request(db, shop, ana);
  assert.equal((await quotes.request(db, shop, ana)).id, request.id, "a second tap returns the first request");
  assert.deepEqual((await quotes.ownerRequests(db, shop)).requests.map((r) => r.id), [request.id]);
  const validUntil = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const quote = await quotes.answer(db, shop, request.id, { lines: [{ name: "Troca de tomada", quantity: 2, unit_amount_cents: 4500 }], valid_until: validUntil });
  assert.equal(quote.status, "offered");
  assert.equal(quote.versions[0].total_amount_cents, 9000);
  await rejects(quotes.answer(db, shop, request.id, { lines: [{ name: "x", quantity: 1, unit_amount_cents: 1 }], valid_until: validUntil }), "quote_not_open");
  assert.deepEqual((await quotes.ownerRequests(db, shop)).requests, []);
  const v2 = await quotes.revise(db, shop, quote.id, { lines: [{ name: "Troca de tomada", quantity: 2, unit_amount_cents: 4000 }], valid_until: validUntil });
  assert.equal(v2.current_version, 2);
  assert.equal(v2.versions.length, 2);
  await rejects(quotes.refuse(db, shop, ana, quote.id, { version: 1 }), "quote_version_changed");
  await rejects(quotes.customerQuote(db, shop, bia, quote.id), "not_found");
  assert.equal((await quotes.refuse(db, shop, ana, quote.id, { version: 2 })).status, "refused");
  await rejects(quotes.revise(db, shop, quote.id, { lines: [{ name: "x", quantity: 1, unit_amount_cents: 1 }], valid_until: validUntil }), "quote_not_open");
});

test("quotes: accepting makes one order, or one booking, atomically; an expired quote cannot be accepted", async (t) => {
  const db = await setup(t);
  const validUntil = new Date(Date.now() + 86_400_000).toISOString();
  const q1 = await quotes.answer(db, shop, (await quotes.request(db, shop, ana)).id, { lines: [{ name: "Bolo de festa", quantity: 1, unit_amount_cents: 12000 }], valid_until: validUntil });
  const accepted = await quotes.accept(db, shop, ana, q1.id, { version: 1, target: "order", fulfilment: "pickup", payment: "in_person" });
  assert.equal(accepted.status, "accepted");
  assert.ok(accepted.order_id);
  const again = await quotes.accept(db, shop, ana, q1.id, { version: 1, target: "order", fulfilment: "pickup", payment: "in_person" });
  assert.equal(again.order_id, accepted.order_id, "a retry makes no second order");
  const order = (await orders.myOrders(db, ana)).orders[0];
  assert.equal(order.total_amount_cents, 12000);
  assert.equal(order.quote_id, q1.id);

  const state = await agenda.activate(db, API, shop, { template_id: "other", time_zone: "UTC" });
  await agenda.setAvailability(db, shop, state.agendas[0].id, { rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: "00:00", end: "23:45" })) });
  await agenda.setPolicy(db, shop, { ...state.policy, min_notice_minutes: 0 });
  await agenda.saveSettings(db, API, shop, { published: true, time_zone: "UTC" });
  const service = state.services[0];
  const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const slot = (await agenda.slots(db, shop, { service_id: service.id, agenda_id: "any", date_from: day, date_to: day })).days[0].slots[4];
  const q2 = await quotes.answer(db, shop, (await quotes.request(db, shop, bia)).id, { lines: [{ item_id: service.id, quantity: 1, unit_amount_cents: 8000 }], valid_until: validUntil, visit_service_id: service.id });
  assert.equal(q2.versions[0].lines[0].name, "Atendimento");
  const booked = await quotes.accept(db, shop, bia, q2.id, { version: 1, target: "booking", booking: { service_id: service.id, agenda_id: "any", start: slot.start } });
  assert.ok(booked.booking_id);
  assert.equal((await agenda.myBookings(db, bia)).bookings[0].status, "confirmed");

  const q3 = await quotes.answer(db, shop, (await quotes.request(db, shop, bia)).id, { lines: [{ name: "x", quantity: 1, unit_amount_cents: 100 }], valid_until: validUntil });
  await db.query("UPDATE quote_versions SET valid_until = now() - interval '1 minute' WHERE quote_id = $1", [q3.id]);
  assert.equal((await quotes.customerQuote(db, shop, bia, q3.id)).status, "expired");
  await rejects(quotes.accept(db, shop, bia, q3.id, { version: 1, target: "order", fulfilment: "pickup", payment: "in_person" }), "quote_expired");
});
