import assert from "node:assert/strict";
import { test } from "node:test";
import { businessRoutes } from "../dist/business-routes.js";
import { Theft } from "../dist/theft.js";
import { openOwnerWindowForRecovery, requireOwnerDevice } from "../dist/business-seats.js";
import { isolatedDatabase } from "./helpers/database.mjs";

// People on a work account (ADR 0251, ADR 0252, bipe#1055). Synthetic accounts only. A fake MAS keeps sessions in memory.
const shop = "@shop:example.test";
const ana = "@ana:example.test";
const API = "https://api.example.test";

function fakeMas() {
  const state = { sessions: [] };
  return {
    state,
    add(deviceId, createdAt = new Date()) {
      state.sessions.push({ kind: "oauth2-sessions", id: `s-${deviceId}`, deviceId, createdAt: createdAt.toISOString(), finished: false });
    },
    finished: (deviceId) => state.sessions.find((s) => s.deviceId === deviceId)?.finished === true,
    async userByUsername(name) { return { id: `mas-${name}` }; },
    async lockUser() {},
    async unlockUser() {},
    async activeSessions(masId) { return state.sessions.filter((s) => masId === "mas-shop" && !s.finished).map(({ kind, id, deviceId, createdAt }) => ({ kind, id, deviceId, createdAt })); },
    async finishSession(session) { state.sessions.find((s) => s.id === session.id).finished = true; },
  };
}

async function fixture(t) {
  const db = await isolatedDatabase(t);
  await db.query("INSERT INTO signups (user_id, account_type) VALUES ($1, 'company'), ($2, 'personal')", [shop, ana]);
  const mas = fakeMas();
  const auth = {
    async userId(header) { return header.split(" ")[1].split("|")[0]; },
    async session(header) { const [userId, deviceId] = header.split(" ")[1].split("|"); return { userId, deviceId: deviceId || null }; },
  };
  let attested = true;
  const app = businessRoutes({ db, auth, apiUrl: API, siteUrl: "https://site.example.test", clientIp: () => "127.0.0.1", people: { mas, attest: () => attested } });
  app.onError((err, c) => c.json(err.body ? err.body() : { error: "internal" }, err.status ?? 500));
  const call = async (device, method, path, body, user = shop) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${user}|${device}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json() };
  };
  return { db, mas, call, setAttested: (v) => { attested = v; } };
}

const ATT = { attestation: { key_id: "k", attestation_object: "a", challenge: "c" } };
const SEATS = "/v1/me/business/seats";

async function withOwner(t) {
  const f = await fixture(t);
  f.mas.add("OWNER", new Date(Date.now() - 86_400_000));
  const list = await f.call("OWNER", "GET", SEATS);
  assert.equal(list.body.me.role, "owner");
  return f;
}

async function addPerson(f, device = "ANA", name = "Ana") {
  const created = await f.call("OWNER", "POST", SEATS, { name });
  assert.equal(created.status, 200);
  f.mas.add(device);
  const claimed = await f.call(device, "POST", `${SEATS}/claim`, ATT);
  assert.equal(claimed.status, 200);
  return created.body.id;
}

test("a device older than the owner seat is the owner; a new device has no owner rights", async (t) => {
  const { mas, call, db } = await withOwner(t);
  mas.add("STRANGER");
  const list = await call("STRANGER", "GET", SEATS);
  assert.equal(list.body.me.role, "none");
  assert.deepEqual(list.body.unassigned_devices, []);
  assert.equal((await call("STRANGER", "POST", SEATS, { name: "Bia" })).status, 403);
  const owner = await call("OWNER", "GET", SEATS);
  assert.deepEqual(owner.body.unassigned_devices.map((d) => d.device_id), ["STRANGER"]);
  assert.equal(owner.body.max_people, 5);
  const { rows } = await db.query("SELECT count(*)::int AS n FROM business_seats WHERE business_id = $1 AND role = 'owner'", [shop]);
  assert.equal(rows[0].n, 1);
});

test("a person joins through the window with an attestation, then has no owner rights", async (t) => {
  const f = await withOwner(t);
  const { call, mas, setAttested } = f;
  const seat = await call("OWNER", "POST", SEATS, { name: "Ana" });
  assert.equal(seat.body.status, "waiting");
  assert.ok(seat.body.window_expires_at);
  assert.equal((await call("OWNER", "POST", SEATS, { name: "Bia" })).status, 409, "one window at a time");

  mas.add("ANA");
  setAttested(false);
  assert.equal((await call("ANA", "POST", `${SEATS}/claim`, ATT)).status, 403);
  assert.equal((await call("ANA", "GET", SEATS)).body.me.role, "none");
  setAttested(true);
  const joined = await call("ANA", "POST", `${SEATS}/claim`, ATT);
  assert.equal(joined.body.me.role, "attendant");
  assert.equal(joined.body.me.name, "Ana");
  assert.ok(joined.body.seats.every((s) => s.devices.length === 0), "only the owner sees devices");

  for (const [method, path, body] of [["POST", SEATS, { name: "Bia" }], ["DELETE", `${SEATS}/${seat.body.id}`], ["PATCH", `${SEATS}/${seat.body.id}`, { name: "X" }], ["POST", `${SEATS}/backup-rotated`, {}]]) {
    assert.equal((await call("ANA", method, path, body)).status, 403, `${method} ${path}`);
  }
  mas.add("LATE");
  assert.equal((await call("LATE", "POST", `${SEATS}/claim`, ATT)).status, 409, "the window closed");
});

test("the cap counts people, an expired waiting seat frees its place", async (t) => {
  const f = await withOwner(t);
  for (let i = 1; i < 5; i++) await addPerson(f, `P${i}`, `P${i}`);
  assert.equal((await f.call("OWNER", "POST", SEATS, { name: "Sixth" })).status, 409);
  const seats = await f.call("OWNER", "GET", SEATS);
  assert.equal(seats.body.seats.length, 5);
  await f.call("OWNER", "DELETE", `${SEATS}/${seats.body.seats[4].id}`);
  const waiting = await f.call("OWNER", "POST", SEATS, { name: "Again" });
  assert.equal(waiting.status, 200);
  await f.db.query("UPDATE business_seats SET window_expires_at = now() - interval '1 minute' WHERE id = $1", [waiting.body.id]);
  assert.equal((await f.call("OWNER", "POST", SEATS, { name: "Other" })).status, 200);
});

test("remove ends the person's sessions and asks for a rotation; a waiting seat does not", async (t) => {
  const f = await withOwner(t);
  const waiting = await f.call("OWNER", "POST", SEATS, { name: "Bia" });
  await f.call("OWNER", "DELETE", `${SEATS}/${waiting.body.id}`);
  assert.equal((await f.call("OWNER", "GET", SEATS)).body.backup_rotation_pending, false);

  const id = await addPerson(f);
  const removed = await f.call("OWNER", "DELETE", `${SEATS}/${id}`);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.backup_rotation_pending, true);
  assert.equal(f.mas.finished("ANA"), true);
  assert.equal(f.mas.finished("OWNER"), false);
  assert.equal((await f.call("ANA", "GET", SEATS)).body.me.role, "none");
  assert.equal((await f.call("OWNER", "POST", `${SEATS}/backup-rotated`, {})).body.backup_rotation_pending, false);

  const owner = (await f.call("OWNER", "GET", SEATS)).body.seats[0];
  assert.equal((await f.call("OWNER", "DELETE", `${SEATS}/${owner.id}`)).status, 400, "the owner seat stays");
});

test("an attendant leaves; the owner cannot leave", async (t) => {
  const f = await withOwner(t);
  await addPerson(f);
  assert.equal((await f.call("OWNER", "POST", `${SEATS}/leave`, {})).status, 403);
  assert.equal((await f.call("ANA", "POST", `${SEATS}/leave`, {})).status, 200);
  assert.equal(f.mas.finished("ANA"), true);
  assert.equal((await f.call("OWNER", "GET", SEATS)).body.backup_rotation_pending, true);
});

test("the owner names or removes a device with no person, but not their own", async (t) => {
  const f = await withOwner(t);
  const id = await addPerson(f);
  f.mas.add("STRAY");
  f.mas.add("OTHER");
  assert.equal((await f.call("OWNER", "PUT", `${SEATS}/devices/STRAY`, { seat_id: id })).status, 200);
  assert.equal((await f.call("STRAY", "GET", SEATS)).body.me.role, "attendant");
  assert.equal((await f.call("OWNER", "PUT", `${SEATS}/devices/STRAY`, { seat_id: id })).status, 400, "it has a person");
  assert.equal((await f.call("OWNER", "PUT", `${SEATS}/devices/GONE`, { seat_id: id })).status, 404);
  assert.equal((await f.call("OWNER", "DELETE", `${SEATS}/devices/OTHER`)).status, 200);
  assert.equal(f.mas.finished("OTHER"), true);
  assert.equal((await f.call("OWNER", "DELETE", `${SEATS}/devices/OWNER`)).status, 400);
});

test("the owner window and a recovery make the next device the owner's", async (t) => {
  const f = await withOwner(t);
  const owner = (await f.call("OWNER", "GET", SEATS)).body.seats[0];
  assert.ok((await f.call("OWNER", "POST", `${SEATS}/${owner.id}/window`, {})).body.window_expires_at);
  assert.equal((await f.call("OWNER", "POST", SEATS, { name: "Ana" })).status, 409);
  f.mas.add("PHONE2");
  assert.equal((await f.call("PHONE2", "GET", SEATS)).body.me.role, "owner");
  f.mas.add("AFTER");
  assert.equal((await f.call("AFTER", "GET", SEATS)).body.me.role, "none", "the window closed");

  await openOwnerWindowForRecovery(f.db, shop);
  f.mas.add("RECOVERED");
  assert.equal((await f.call("RECOVERED", "GET", SEATS)).body.me.role, "owner");
  const id = await addPerson(f);
  assert.equal((await f.call("OWNER", "POST", `${SEATS}/${id}/window`, {})).status, 400, "only the owner's own seat");
});

test("only a company account has seats; the guard leaves personal accounts alone and fails closed with no device", async (t) => {
  const { db, mas, call } = await fixture(t);
  assert.equal((await call("D", "GET", SEATS, undefined, ana)).status, 404);
  await requireOwnerDevice({ db, mas }, ana, "ANY");
  await assert.rejects(requireOwnerDevice({ db, mas }, shop, null), (e) => e.id === "owner_only");
});

test("the second_seat step can be skipped for good", async (t) => {
  const f = await withOwner(t);
  assert.equal((await f.call("ANA", "POST", "/v1/me/business/setup/second-seat-skip", {})).status, 403);
  assert.equal((await f.call("OWNER", "POST", "/v1/me/business/setup/second-seat-skip", {})).status, 200);
  const { rows } = await f.db.query("SELECT second_seat_skipped FROM business_work_settings WHERE business_id = $1", [shop]);
  assert.equal(rows[0].second_seat_skipped, true);
});

test("a stolen phone ends that person's web sessions, and another person's stay", async (t) => {
  const f = await withOwner(t);
  const signer = { signTheft: () => ({}) };
  const theft = new Theft(f.db, f.mas, signer, "example.test");
  const guardian = "@bia:example.test";
  await f.db.query("INSERT INTO signups (user_id, account_type) VALUES ($1, 'personal')", [guardian]);
  const id = await addPerson(f);
  f.mas.add("ANAWEB");
  f.mas.add("OWNERWEB");
  const owner = (await f.call("OWNER", "GET", SEATS)).body.seats[0];
  await f.call("OWNER", "PUT", `${SEATS}/devices/ANAWEB`, { seat_id: id });
  await f.call("OWNER", "PUT", `${SEATS}/devices/OWNERWEB`, { seat_id: owner.id });
  await f.db.query("UPDATE business_seat_devices SET kind = 'web' WHERE device_id IN ('ANAWEB', 'OWNERWEB')");
  await f.db.query("INSERT INTO web_links (user_id, web_device_id, approver_device_id) VALUES ($1, 'ANAWEB', 'OWNER'), ($1, 'OWNERWEB', 'OWNER')", [shop]);
  await f.db.query("INSERT INTO guardians (owner_id, guardian_id) VALUES ($1, $2)", [ana, guardian]);
  await f.db.query("INSERT INTO account_phones (user_id, device_id, phone_id) VALUES ($1, 'P', 'phone-a'), ($2, 'ANA', 'phone-a')", [ana, shop]);
  await theft.mark(guardian, ana).catch(() => {});
  assert.equal(f.mas.finished("ANA"), true);
  assert.equal(f.mas.finished("ANAWEB"), true);
  assert.equal(f.mas.finished("OWNER"), false);
  assert.equal(f.mas.finished("OWNERWEB"), false);
  assert.equal((await f.call("OWNER", "GET", SEATS)).body.backup_rotation_pending, true);
});

test("an owner phone stolen leaves the web session of a person that it approved", async (t) => {
  const f = await withOwner(t);
  const theft = new Theft(f.db, f.mas, { signTheft: () => ({}) }, "example.test");
  const guardian = "@bia:example.test";
  await f.db.query("INSERT INTO signups (user_id, account_type) VALUES ($1, 'personal')", [guardian]);
  const id = await addPerson(f);
  f.mas.add("ANAWEB");
  await f.call("OWNER", "PUT", `${SEATS}/devices/ANAWEB`, { seat_id: id });
  await f.db.query("INSERT INTO web_links (user_id, web_device_id, approver_device_id) VALUES ($1, 'ANAWEB', 'OWNER')", [shop]);
  await f.db.query("INSERT INTO guardians (owner_id, guardian_id) VALUES ($1, $2)", [ana, guardian]);
  await f.db.query("INSERT INTO account_phones (user_id, device_id, phone_id) VALUES ($1, 'P', 'phone-b'), ($2, 'OWNER', 'phone-b')", [ana, shop]);
  await theft.mark(guardian, ana).catch(() => {});
  assert.equal(f.mas.finished("OWNER"), true);
  assert.equal(f.mas.finished("ANAWEB"), false);
  assert.equal(f.mas.finished("ANA"), false);
});
