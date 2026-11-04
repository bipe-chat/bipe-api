import assert from "node:assert/strict";
import { test } from "node:test";
import { mayInvite } from "../dist/messaging.js";
import { inviteeHash, inviteeKey, Reach } from "../dist/reach.js";
import { isolatedDatabase } from "./helpers/database.mjs";

// bipe#845: first-contact outcomes. Synthetic IDs only.
const SECRET = "reach-test-secret-0123456789abcdef0123456789";
const ana = "@ana:example.test";
const bia = "@bia:example.test";
const cia = "@cia:example.test";

const counts = async (db, user) =>
  (await db.query("SELECT sent, accepted, declined, ignored, blocked, reported FROM reach_daily WHERE user_id = $1", [user])).rows
    .reduce((a, r) => Object.fromEntries(Object.keys(r).map((k) => [k, (a[k] ?? 0) + r[k]])), {});

test("only an allowed first contact is recorded, never the invitee in clear", async (t) => {
  const db = await isolatedDatabase(t);
  const reach = new Reach(db, { secret: SECRET, serverName: "example.test" });
  assert.deepEqual(await mayInvite(db, ana, bia, false, { reach, roomId: "!r1:example.test" }), { allow: true, policy: "everyone" });
  // A contact (shared room) is not a first contact.
  await mayInvite(db, ana, cia, true, { reach, roomId: "!r2:example.test" });
  // A policy refusal records nothing.
  await db.query("INSERT INTO messaging_policies (user_id, policy) VALUES ($1, 'contacts')", [cia]);
  assert.equal((await mayInvite(db, ana, cia, false, { reach, roomId: "!r3:example.test" })).allow, false);
  const { rows } = await db.query("SELECT inviter, invitee_hash, room_id FROM first_contacts");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].room_id, "!r1:example.test");
  assert.equal(rows[0].invitee_hash, inviteeHash(inviteeKey(SECRET), bia));
  assert.ok(!JSON.stringify(rows).includes(bia));
  assert.equal((await counts(db, ana)).sent, 1);
});

test("off without the secret: nothing is recorded", async (t) => {
  const db = await isolatedDatabase(t);
  const reach = new Reach(db, { serverName: "example.test" });
  assert.equal((await mayInvite(db, ana, bia, false, { reach, roomId: "!r1:example.test" })).allow, true);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM first_contacts")).rows[0].n, 0);
  assert.equal(await reach.membership("!r1:example.test", bia, "join"), 0);
});

test("join accepts, own leave declines, the first outcome sticks", async (t) => {
  const db = await isolatedDatabase(t);
  const reach = new Reach(db, { secret: SECRET, serverName: "example.test" });
  await reach.record(ana, bia, "!r1:example.test");
  await reach.record(ana, cia, "!r2:example.test");
  assert.equal(await reach.membership("!r1:example.test", bia, "join"), 1);
  assert.equal(await reach.membership("!r1:example.test", bia, "leave"), 0, "a leave after the join changes nothing");
  assert.equal(await reach.membership("!r2:example.test", cia, "leave"), 1);
  assert.equal(await reach.membership("!other:example.test", bia, "join"), 0);
  assert.deepEqual(await counts(db, ana), { sent: 2, accepted: 1, declined: 1, ignored: 0, blocked: 0, reported: 0 });
});

test("an ignore of the inviter within the window is one block per inviter", async (t) => {
  const db = await isolatedDatabase(t);
  const reach = new Reach(db, { secret: SECRET, serverName: "example.test" });
  await reach.record(ana, bia, "!r1:example.test");
  await reach.record(ana, bia, "!r2:example.test");
  await reach.record(cia, bia, "!r3:example.test", new Date(Date.now() - 8 * 86_400_000));
  assert.equal(await reach.ignored(bia, [ana, cia, "@other:example.test"]), 1, "cia's first contact is outside the window");
  assert.equal(await reach.ignored(bia, [ana]), 0, "the same block counts once");
  assert.equal((await counts(db, ana)).blocked, 1);
  assert.equal((await counts(db, cia)).blocked ?? 0, 0);
});

test("prune: a first contact goes after recipientDays and counts as ignored when nothing happened", async (t) => {
  const db = await isolatedDatabase(t);
  const reach = new Reach(db, { secret: SECRET, serverName: "example.test" });
  const old = new Date(Date.now() - 8 * 86_400_000);
  await reach.record(ana, bia, "!r1:example.test", old);
  await reach.record(ana, cia, "!r2:example.test", old);
  await reach.record(ana, "@dan:example.test", "!r3:example.test", old);
  await reach.record(ana, "@eva:example.test", "!r4:example.test");
  await reach.membership("!r1:example.test", bia, "join");
  await db.query("UPDATE first_contacts SET blocked_at = now() WHERE room_id = '!r2:example.test'");
  const pruned = await reach.prune();
  assert.equal(pruned.firstContacts, 3);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM first_contacts")).rows[0].n, 1);
  const c = await counts(db, ana);
  assert.equal(c.sent, 4);
  assert.equal(c.ignored, 1, "only the first contact with no outcome and no block");
  await db.query("INSERT INTO reach_daily (user_id, day, sent) VALUES ($1, current_date - 200, 5)", [cia]);
  assert.equal((await reach.prune()).days, 1);
  assert.equal(await reach.daily(ana, 30).then((r) => r.reduce((n, d) => n + d.sent, 0)), 4);
});

test("user reports count against the local sender of the reported event", async (t) => {
  const db = await isolatedDatabase(t);
  // A stand-in for the Synapse database: the same tables and columns as the bipe_growth grants.
  const synapse = await isolatedDatabase(t);
  await synapse.query("CREATE TABLE event_reports (id bigint PRIMARY KEY, received_ts bigint, event_id text)");
  await synapse.query("CREATE TABLE events (event_id text PRIMARY KEY, sender text)");
  const now = Date.now();
  await synapse.query("INSERT INTO events VALUES ('$e1', $1), ('$e2', $1), ('$e3', '@far:remote.test')", [ana]);
  await synapse.query("INSERT INTO event_reports VALUES (1, $1, '$e1'), (2, $1, '$e2'), (3, $1, '$e3'), (4, $1, '$gone')", [now]);
  const reach = new Reach(db, { secret: SECRET, serverName: "example.test" });
  // Point the reader at the stand-in pool.
  reach.synapse = synapse;
  assert.equal(await reach.syncReports(), 4);
  assert.equal((await counts(db, ana)).reported, 2);
  assert.equal(await reach.syncReports(), 0, "the cursor moved");
  await synapse.query("INSERT INTO event_reports VALUES (5, $1, '$e1')", [now]);
  assert.equal(await reach.syncReports(), 1);
  assert.equal((await counts(db, ana)).reported, 3);
});
