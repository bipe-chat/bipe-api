import assert from "node:assert/strict";
import { test } from "node:test";
import { NewsBot, newsList, queueNewsItem, requestNewsBackfill } from "../dist/news.js";
import { isolatedDatabase } from "./helpers/database.mjs";

// Novidades do Bipe (ADR 0117, bipe#383, bipe#387) against Postgres. The homeserver is a stub: createRoom answers a
// new room ID, membership comes from a map, and sendText records the room. Synthetic IDs only.
const BOT = "@bipe:example.test";

function stubBot(db, { perMinute = 60, failRooms = new Set() } = {}) {
  const config = {
    NEWS_USER_ID: BOT, NEWS_ACCESS_TOKEN: "test-only-token-0000", NEWS_STORE_DIR: "/nonexistent",
    NEWS_STORE_PASSPHRASE: "test-only-passphrase-0000000000000000", SYNAPSE_URL: "http://127.0.0.1:9", NEWS_SEND_PER_MINUTE: perMinute,
  };
  const bot = new NewsBot(db, config);
  const sent = [];
  const left = [];
  const created = [];
  const members = new Map();
  let n = 0;
  bot.sendText = async (roomId, body, msgtype, txnId) => {
    if (failRooms.has(roomId)) throw new Error("matrix PUT /rooms: HTTP 403 M_FORBIDDEN");
    sent.push({ roomId, body, msgtype, txnId });
  };
  bot.matrix = async (method, path, body) => {
    if (method === "POST" && path === "/createRoom") {
      const roomId = `!news${++n}:example.test`;
      created.push({ roomId, body });
      members.set(roomId, "invite");
      return { room_id: roomId };
    }
    if (method === "POST" && path.endsWith("/leave")) { left.push(decodeURIComponent(path.split("/")[2])); return {}; }
    throw new Error(`unexpected ${method} ${path}`);
  };
  bot.membership = async (roomId) => members.get(roomId) ?? null;
  return { bot, sent, left, created, members };
}

const signUp = (db, userId) => db.query("INSERT INTO signups (user_id) VALUES ($1)", [userId]);
const flush = () => new Promise((r) => setTimeout(r, 50));

test("sign-up makes one read-only room with the welcome item; a second welcome makes nothing", async (t) => {
  const db = await isolatedDatabase(t);
  const { bot, sent, created } = stubBot(db);
  bot.welcome("@ana:example.test");
  await flush();
  bot.welcome("@ana:example.test");
  await flush();
  assert.equal(created.length, 1);
  const req = created[0].body;
  assert.equal(req.is_direct, true);
  assert.deepEqual(req.invite, ["@ana:example.test"]);
  assert.equal(req.room_version, "12");
  assert.equal(req.power_level_content_override.users[BOT], undefined);
  assert.equal(req.power_level_content_override.users["@ana:example.test"], 0);
  assert.equal(req.power_level_content_override.events_default, 50);
  assert.equal(req.initial_state[0].type, "m.room.encryption");
  assert.deepEqual(sent.map((s) => s.msgtype), ["m.notice"]);
  assert.deepEqual(await bot.state("@ana:example.test"), { subscribed: true, room_id: created[0].roomId });
});

test("an item reaches each room once, as m.notice or m.text, and skips users who left", async (t) => {
  const db = await isolatedDatabase(t);
  const { bot, sent, created } = stubBot(db);
  for (const u of ["@ana:example.test", "@bia:example.test", "@caio:example.test"]) bot.welcome(u);
  await flush();
  // Bia leaves the room: the bot sees her leave in its sync.
  const bia = created.find((c) => c.body.invite[0] === "@bia:example.test").roomId;
  await bot.onTimelineEvent(bia, { type: "m.room.member", sender: "@bia:example.test", state_key: "@bia:example.test", event_id: "$1", content: { membership: "leave" } });
  sent.length = 0;

  await queueNewsItem(db, { id: "stickers", text: "Figurinhas chegaram.", importance: "normal" });
  await assert.rejects(queueNewsItem(db, { id: "stickers", text: "De novo.", importance: "normal" }), /exists already/);
  await bot.tick();
  await bot.tick();
  assert.equal(sent.length, 2);
  assert.ok(sent.every((s) => s.msgtype === "m.notice" && /Suporte Bipe/.test(s.body)));
  assert.ok(!sent.some((s) => s.roomId === bia));
  await bot.tick();
  assert.equal(sent.length, 2, "a retry sends nothing new");

  await queueNewsItem(db, { id: "terms", text: "Termos novos.", importance: "important" });
  await bot.tick();
  assert.deepEqual(sent.slice(2).map((s) => s.msgtype), ["m.text", "m.text"]);
  const report = await newsList(db);
  assert.equal(report.rooms, 3);
  assert.equal(report.opted_out, 1);
  assert.deepEqual(report.items.map((i) => [i.id, i.sent]), [["terms", 2], ["stickers", 2]]);
});

test("the send rate is a limit per tick, and a room that keeps failing does not block the item", async (t) => {
  const db = await isolatedDatabase(t);
  const failRooms = new Set();
  const { bot, sent, created } = stubBot(db, { perMinute: 2, failRooms });
  for (const u of ["@a:example.test", "@b:example.test", "@c:example.test"]) bot.welcome(u);
  await flush();
  failRooms.add(created[0].roomId);
  sent.length = 0;
  await queueNewsItem(db, { id: "one", text: "Uma.", importance: "normal" });
  await bot.tick();
  assert.equal(sent.length, 1, "two tries in the first tick, one of them failed");
  for (let i = 0; i < 4; i++) await bot.tick();
  assert.equal(sent.length, 2);
  const { rows } = await db.query("SELECT user_id, failed FROM news_deliveries WHERE item_id = 'one' ORDER BY user_id");
  assert.deepEqual(rows.map((r) => [r.user_id, r.failed]), [["@a:example.test", true], ["@b:example.test", false], ["@c:example.test", false]]);
  const { rows: items } = await db.query("SELECT done_at FROM news_items WHERE id = 'one'");
  assert.ok(items[0].done_at, "the item is done");
});

test("an item does not go to rooms made after it was queued", async (t) => {
  const db = await isolatedDatabase(t);
  const { bot, sent } = stubBot(db);
  await queueNewsItem(db, { id: "old", text: "Antiga.", importance: "normal" });
  bot.welcome("@new:example.test");
  await flush();
  sent.length = 0;
  await bot.tick();
  await bot.tick();
  assert.equal(sent.length, 0);
});

test("the Settings switch: off stops items, on makes a new room and leaves the old one", async (t) => {
  const db = await isolatedDatabase(t);
  const { bot, sent, left, created, members } = stubBot(db);
  const ana = "@ana:example.test";
  bot.welcome(ana);
  await flush();
  const first = created[0].roomId;
  members.set(first, "join");
  assert.deepEqual(await bot.subscribe(ana), { subscribed: true, room_id: first }, "joined: the room stays");

  await bot.unsubscribe(ana);
  assert.deepEqual(await bot.state(ana), { subscribed: false });
  members.set(first, "leave");
  sent.length = 0;
  await queueNewsItem(db, { id: "a", text: "A.", importance: "normal" });
  await bot.tick();
  assert.equal(sent.length, 0);

  const on = await bot.subscribe(ana);
  assert.notEqual(on.room_id, first);
  assert.deepEqual(left, [first]);
  assert.deepEqual(await bot.state(ana), { subscribed: true, room_id: on.room_id });
  sent.length = 0;
  await bot.tick();
  assert.equal(sent.length, 0, "an item queued before the new room does not go there");
  await queueNewsItem(db, { id: "b", text: "B.", importance: "normal" });
  await bot.tick();
  assert.deepEqual(sent.map((s) => s.roomId), [on.room_id]);
});

test("backfill makes rooms for earlier sign-ups only after staff ask, then clears the request", async (t) => {
  const db = await isolatedDatabase(t);
  const { bot, created } = stubBot(db);
  for (const u of ["@old1:example.test", "@old2:example.test"]) await signUp(db, u);
  await bot.tick();
  assert.equal(created.length, 0);
  await requestNewsBackfill(db);
  await bot.tick();
  assert.equal(created.length, 2);
  await bot.tick();
  const { rows } = await db.query("SELECT backfill_requested_at, backfill_done_at FROM news_state");
  assert.equal(rows[0].backfill_requested_at, null);
  assert.ok(rows[0].backfill_done_at);
  await signUp(db, "@old3:example.test");
  await bot.tick();
  assert.equal(created.length, 2, "no backfill without a new request");
});

test("a user who left is not invited again by sign-up or backfill", async (t) => {
  const db = await isolatedDatabase(t);
  const { bot, created } = stubBot(db);
  await signUp(db, "@ana:example.test");
  bot.welcome("@ana:example.test");
  await flush();
  await bot.unsubscribe("@ana:example.test");
  await requestNewsBackfill(db);
  await bot.tick();
  bot.welcome("@ana:example.test");
  await flush();
  assert.equal(created.length, 1);
});
