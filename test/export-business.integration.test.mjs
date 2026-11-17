import assert from "node:assert/strict";
import { test } from "node:test";
import { exportData } from "../dist/export.js";
import { isolatedDatabase } from "./helpers/database.mjs";

// bipe-chat/bipe#1404. Synthetic IDs only. The export of a company holds its own tool setup and quote lines, never
// the names or IDs of its customers.
test("a company export holds its agenda, queue, order and quote data", async (t) => {
  const db = await isolatedDatabase(t);
  const shop = "@loja1404:example.test";
  const customer = "@cliente1404:example.test";
  await db.query(
    `INSERT INTO agenda_settings (business_id, published, time_zone, min_notice_minutes, horizon_days, slot_step_minutes,
       cancel_window_minutes, confirm_mode, max_open_bookings, reminder_minutes)
     VALUES ($1, true, 'America/Sao_Paulo', 60, 30, 15, 120, 'auto', 2, '{60}')`,
    [shop],
  );
  await db.query("INSERT INTO agendas (id, business_id, name, active, sort) VALUES ('ag1', $1, 'Cadeira 1', true, 0)", [shop]);
  await db.query(
    `INSERT INTO agenda_overrides (id, business_id, agenda_id, date_from, date_to, closed, ranges)
     VALUES ('ov1', $1, 'ag1', '2026-12-24', '2026-12-25', true, '[]')`,
    [shop],
  );
  await db.query("INSERT INTO queue_settings (business_id, no_show_after_minutes) VALUES ($1, 10)", [shop]);
  await db.query("INSERT INTO queues (id, business_id, day, time_zone, open) VALUES ('q1', $1, '2026-11-17', 'America/Sao_Paulo', true)", [shop]);
  await db.query(
    "INSERT INTO queue_places (id, queue_id, business_id, customer_id, source, status) VALUES ('p1', 'q1', $1, $2, 'customer', 'waiting')",
    [shop, customer],
  );
  await db.query("INSERT INTO order_settings (business_id, time_zone, weekdays, cutoff) VALUES ($1, 'America/Sao_Paulo', '{1,2,3,4,5}', '18:00')", [shop]);
  await db.query("INSERT INTO quote_requests (id, business_id, customer_id) VALUES ('r1', $1, $2)", [shop, customer]);
  await db.query("INSERT INTO quotes (id, request_id, business_id, customer_id, status, current_version) VALUES ('qt1', 'r1', $1, $2, 'offered', 1)", [shop, customer]);
  await db.query(
    `INSERT INTO quote_versions (quote_id, version, valid_until, lines, total_amount_cents)
     VALUES ('qt1', 1, now() + interval '7 days', '[{"label":"Pintura","amount_cents":15000}]', 15000)`,
  );

  const exported = await exportData(db, { rowsOf: async () => [] }, shop);
  assert.equal(exported.agenda_settings.time_zone, "America/Sao_Paulo");
  assert.deepEqual(exported.agendas.map((a) => a.id), ["ag1"]);
  assert.deepEqual(exported.agenda_overrides.map((o) => o.id), ["ov1"]);
  assert.equal(exported.queue_settings.no_show_after_minutes, 10);
  assert.deepEqual(exported.queues.map((q) => q.id), ["q1"]);
  assert.deepEqual(exported.business_queue_places.map((p) => p.id), ["p1"]);
  assert.equal(exported.order_settings.cutoff, "18:00");
  assert.equal(exported.quote_versions.length, 1);
  assert.equal(Number(exported.quote_versions[0].total_amount_cents), 15000);
  assert.ok(!JSON.stringify(exported.business_queue_places).includes(customer), "no customer ID on the company's queue places");

  const theirs = await exportData(db, { rowsOf: async () => [] }, customer);
  assert.equal(theirs.quote_versions.length, 1, "the customer sees the lines of a quote made for them");
  assert.equal(theirs.agenda_settings, null);
});
