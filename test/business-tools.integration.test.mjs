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

test("tool state: starts off; a dependency blocks; live tools only reach customers; steps and suggestions", async (t) => {
  const db = await setup(t);
  const tools = await import("../dist/business-tools.js");
  const states = async () => Object.fromEntries((await tools.tools(db, shop)).tools.map((x) => [x.id, x.state]));
  assert.deepEqual(await states(), { catalog: "off", agenda: "off", orders: "off", quotes: "off", queue: "off" });
  await rejects(tools.setToolState(db, API, shop, "orders", "setup"), "tool_needs_catalog");
  await rejects(tools.requireLive(db, shop, "queue"), "tool_not_live");
  await catalog.createItem(db, API, shop, product("Bolo", { mode: "fixed", text: "R$ 10", amount_cents: 1000 }));
  await catalog.createItem(db, API, shop, product("Festa", { mode: "on_request" }));
  assert.deepEqual((await tools.suggestions(db, shop)).suggestions.map((s) => s.id), ["quotes_for_on_request", "orders_for_products"]);
  assert.deepEqual((await tools.dismissSuggestion(db, shop, "orders_for_products")).suggestions.map((s) => s.id), ["quotes_for_on_request"]);
  await tools.setToolState(db, API, shop, "orders", "live");
  assert.deepEqual((await tools.liveTools(db, shop)).tools, ["orders"]);
  assert.equal(await tools.catalogIsPublic(db, shop), true);
  await tools.setToolState(db, API, shop, "orders", "off");
  assert.equal(await tools.catalogIsPublic(db, shop), false);
  let plan = await tools.setup(db, shop);
  assert.equal(plan.first_tool, "catalog");
  assert.equal(plan.done_count, 0);
  assert.ok(!plan.steps.some((s) => s.id === "second_seat"), "no seats yet");
  await tools.setSector(db, shop, { sector: "food" });
  plan = await tools.setup(db, shop);
  assert.equal(plan.first_tool, "orders");
  await rejects(tools.setSector(db, shop, { sector: "nope" }), "bad_request");
  const today = await tools.today(db, shop);
  assert.deepEqual(today, { bookings: [], orders: [], queue_open: false, queue_waiting: 0, quote_requests: [] });
});

test("tool state: the Agenda maps activation to setup and publication to live; off hides it and keeps it", async (t) => {
  const db = await setup(t);
  const tools = await import("../dist/business-tools.js");
  const state = async () => (await tools.tools(db, shop)).tools.find((x) => x.id === "agenda").state;
  await rejects(tools.setToolState(db, API, shop, "agenda", "live"), "tool_needs_catalog");
  await agenda.activate(db, API, shop, { template_id: "barbershop", time_zone: "UTC" });
  assert.equal(await state(), "setup");
  await tools.setToolState(db, API, shop, "agenda", "live");
  assert.equal(await state(), "live");
  await tools.setToolState(db, API, shop, "agenda", "off");
  assert.equal(await state(), "off");
  assert.equal((await agenda.agendaState(db, API, shop)).published, false);
  await tools.setToolState(db, API, shop, "agenda", "live");
  assert.equal(await state(), "live");
});

test("shop on the web: token, one open order, cancel, switches, claim", async (t) => {
  const db = await setup(t);
  const tools = await import("../dist/business-tools.js");
  const shopWeb = await import("../dist/shop-web.js");
  const item = await catalog.createItem(db, API, shop, product("Pão", { mode: "fixed", text: "R$ 2", amount_cents: 200 }));
  const body = { name: "Zé", lines: [{ item_id: item.id, quantity: 2 }] };
  await rejects(shopWeb.order(db, shop, undefined, body), "tool_not_live");
  await tools.setToolState(db, API, shop, "orders", "live");
  const first = await shopWeb.order(db, shop, undefined, body);
  assert.ok(first.token);
  assert.equal(first.order.web, true);
  assert.deepEqual(first.order.customer, { name: "Zé" });
  assert.equal(first.order.fulfilment, "pickup");
  await rejects(shopWeb.order(db, shop, first.token, body), "order_already_open");
  await rejects(shopWeb.order(db, shop, "wrong", body), "shop_token_invalid");
  assert.equal((await shopWeb.records(db, shop, first.token)).orders.length, 1);
  assert.equal((await shopWeb.cancelOrder(db, shop, first.token, first.order.id)).status, "cancelled");
  const second = await shopWeb.order(db, shop, first.token, body);
  assert.equal(second.token, undefined, "the token comes back once");
  await tools.setWebSettings(db, shop, { web_booking: true, web_orders: false, web_queue: true });
  await rejects(shopWeb.order(db, shop, undefined, body), "web_off");
  assert.equal((await tools.liveTools(db, shop)).web_orders, false);
  const claimed = await shopWeb.claim(db, shop, first.token, ana);
  assert.equal(claimed.orders.length, 2);
  assert.ok(claimed.orders.every((o) => o.customer.user_id === ana));
  await rejects(shopWeb.records(db, shop, first.token), "shop_token_invalid");
});

test("shop on the web: a booking starts requested, one open per token; the owner sees web", async (t) => {
  const db = await setup(t);
  const tools = await import("../dist/business-tools.js");
  const shopWeb = await import("../dist/shop-web.js");
  await agenda.activate(db, API, shop, { template_id: "barbershop", time_zone: "UTC" });
  await tools.setToolState(db, API, shop, "agenda", "live");
  const service = (await agenda.publicServices(db, API, shop)).services[0];
  const date = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const days = await agenda.slots(db, shop, { service_id: service.id, agenda_id: "any", date_from: date, date_to: new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10) });
  const free = days.days.flatMap((d) => d.slots);
  const made = await shopWeb.book(db, shop, undefined, { name: "Zé", service_id: service.id, agenda_id: "any", start: free[0].start });
  assert.equal(made.booking.status, "requested");
  assert.equal(made.booking.web, true);
  await rejects(shopWeb.book(db, shop, made.token, { name: "Zé", service_id: service.id, agenda_id: "any", start: free[1].start }), "too_many_open_bookings");
});

test("web queue: a first name, one place per token, leave, switch, claim", async (t) => {
  const db = await setup(t);
  const tools = await import("../dist/business-tools.js");
  const shopWeb = await import("../dist/shop-web.js");
  await rejects(shopWeb.joinQueue(db, shop, undefined, { name: "Zé" }), "tool_not_live");
  await tools.setToolState(db, API, shop, "queue", "live");
  await rejects(shopWeb.joinQueue(db, shop, undefined, { name: "Zé" }), "queue_closed");
  await queue.setOpen(db, shop, true);
  const first = await shopWeb.joinQueue(db, shop, undefined, { name: "Zé" });
  assert.ok(first.token);
  assert.equal(first.position.position, 1);
  assert.equal(first.position.place.web, true);
  await rejects(shopWeb.joinQueue(db, shop, first.token, { name: "Zé" }), "already_in_queue");
  assert.equal((await shopWeb.records(db, shop, first.token)).queue_place.position, 1);
  assert.equal((await shopWeb.leaveQueue(db, shop, first.token, first.position.place.id)).place.status, "left");
  assert.equal((await shopWeb.records(db, shop, first.token)).queue_place, undefined);
  await tools.setWebSettings(db, shop, { web_booking: true, web_orders: true, web_queue: false });
  await rejects(shopWeb.joinQueue(db, shop, first.token, { name: "Zé" }), "web_off");
  await tools.setWebSettings(db, shop, { web_booking: true, web_orders: true, web_queue: true });
  const again = await shopWeb.joinQueue(db, shop, first.token, { name: "Zé" });
  await shopWeb.claim(db, shop, first.token, ana);
  assert.equal((await queue.myPlace(db, shop, ana)).place.id, again.position.place.id);
});

test("quote link: a typed name, read and accept with the link, one order, revoke", async (t) => {
  const db = await setup(t);
  const body = { customer_name: "Carla", lines: [{ name: "Pintura", quantity: 1, unit_amount_cents: 5000 }], valid_until: new Date(Date.now() + 86_400_000).toISOString() };
  const { quote, linkId } = await quotes.createLinkQuote(db, shop, body);
  assert.equal(quote.customer_id, "");
  assert.equal(quote.customer_name, "Carla");
  assert.equal(quote.has_link, true);
  const read = await quotes.readLink(db, shop, linkId);
  assert.equal(read.version.total_amount_cents, 5000);
  await rejects(quotes.readLink(db, shop, "wrong"), "not_found");
  const accepted = await quotes.acceptLink(db, shop, linkId, 1);
  assert.equal(accepted.status, "accepted");
  assert.equal((await quotes.acceptLink(db, shop, linkId, 1)).status, "accepted", "a retry makes no second order");
  const list = (await orders.ownerOrders(db, shop)).orders;
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].customer, { name: "Carla" });
  assert.equal(list[0].web, true);
  const second = await quotes.createLinkQuote(db, shop, body);
  const renewed = await quotes.renewLink(db, shop, second.quote.id);
  await rejects(quotes.readLink(db, shop, second.linkId), "not_found");
  await quotes.revokeLink(db, shop, second.quote.id);
  await rejects(quotes.readLink(db, shop, renewed.linkId), "not_found");
});

test("parar de receber: a stopped work account cannot invite, even in a shared room; undo works", async (t) => {
  const db = await setup(t);
  const stops = await import("../dist/business-stops.js");
  const { mayInvite } = await import("../dist/messaging.js");
  await db.query("INSERT INTO messaging_settings (user_id, policy) VALUES ($1, 'everyone') ON CONFLICT DO NOTHING", [ana]).catch(() => {});
  assert.deepEqual(await stops.setStopped(db, ana, shop, true), { stopped: true });
  assert.equal(await stops.isStopped(db, ana, shop), true);
  assert.equal((await mayInvite(db, shop, ana, true)).allow, false);
  await stops.setStopped(db, ana, shop, false);
  assert.equal((await mayInvite(db, shop, ana, true)).allow, true);
  await rejects(stops.setStopped(db, ana, bia, true), "not_found");
});

test("parar de receber: a stopped work account may reply within 24 hours or with an open record, and not otherwise", async (t) => {
  const db = await setup(t);
  const stops = await import("../dist/business-stops.js");
  const HOUR = 3_600_000;
  const now = Date.now();
  assert.equal(await stops.mayMessage(db, shop, ana, null, now), true, "not stopped");
  assert.deepEqual(await stops.stoppedBusinesses(db), []);
  await stops.setStopped(db, ana, shop, true);
  assert.deepEqual(await stops.stoppedBusinesses(db), [shop]);
  assert.equal(await stops.mayMessage(db, shop, ana, null, now), false, "no message from the customer");
  assert.equal(await stops.mayMessage(db, shop, ana, now - 25 * HOUR, now), false, "outside the window");
  assert.equal(await stops.mayMessage(db, shop, ana, now - 23 * HOUR, now), true, "a reply");
  assert.equal(await stops.mayMessage(db, shop, bia, null, now), true, "another customer did not stop it");
  await queue.setOpen(db, shop, true);
  const place = await queue.join(db, shop, ana, {});
  assert.equal(await stops.mayMessage(db, shop, ana, null, now), true, "a queue place is open");
  await queue.leave(db, shop, ana, place.place.id);
  assert.equal(await stops.mayMessage(db, shop, ana, null, now), false);
});

test("external calendars: a feed token works once issued and stops when rotated; imported busy times block slots", async (t) => {
  const db = await setup(t);
  const calendars = await import("../dist/agenda-calendars.js");
  await agenda.activate(db, API, shop, { template_id: "barbershop", time_zone: "UTC" });
  const agendaId = (await agenda.listAgendas(db, shop)).agendas[0].id;
  const first = await calendars.issueFeed(db, API, shop, agendaId, { include_customer_first_name: false });
  const token = /feeds\/([^.]+)\.ics$/.exec(first.url)[1];
  assert.match(await calendars.feedIcs(db, token), /BEGIN:VCALENDAR/);
  await calendars.issueFeed(db, API, shop, agendaId, { include_customer_first_name: false });
  await rejects(calendars.feedIcs(db, token), "not_found");
  await rejects(calendars.addImport(db, shop, agendaId, { url: "https://x.test/a.ics" }, async () => { throw new Error("refused"); }), "bad_request");
  const start = new Date(Date.now() + 2 * 86_400_000);
  const stamp = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const text = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Hidden\r\nDTSTART:${stamp(start)}\r\nDTEND:${stamp(new Date(start.getTime() + 3_600_000))}\r\nEND:VEVENT\r\nEND:VCALENDAR`;
  const made = await calendars.addImport(db, shop, agendaId, { url: "https://x.test/a.ics" }, async () => text);
  const { rows } = await db.query("SELECT * FROM busy_blocks WHERE import_id = $1", [made.id]);
  assert.equal(rows.length, 1);
  assert.equal("summary" in rows[0], false);
  await calendars.removeImport(db, shop, agendaId, made.id);
  assert.equal((await db.query("SELECT 1 FROM busy_blocks")).rowCount, 0);
});
