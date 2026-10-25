import assert from "node:assert/strict";
import { test } from "node:test";
import { accountStatus } from "../dist/accounts.js";
import { cancelDeletion, nextOwner, pruneDeletions, requestDeletion, runDueDeletions } from "../dist/deletion.js";
import { exportData } from "../dist/export.js";
import { Mailer } from "../dist/mailer.js";
import { Mas } from "../dist/mas.js";
import { PinHasher } from "../dist/secrets.js";
import { SynapseHttpError } from "../dist/synapse-admin.js";
import { isolatedDatabase } from "./helpers/database.mjs";
import { masStub } from "./helpers/mas.mjs";

// ADR 0140, bipe#528. Synthetic IDs only; a fake Synapse admin API and the MAS stub. Nothing reaches a real service.
const GOOD_PIN = "49382615";
const WRONG_PIN = "58273916";
const pins = new PinHasher("11".repeat(32));
const goodHash = await pins.hash(GOOD_PIN);
let sequence = 0;

class CapturingMailer extends Mailer {
  messages = [];
  sendLater(_to, _subject, text) { this.messages.push(text); }
}

function fakeSynapse(rooms = {}) {
  const calls = { admin: [], redact: 0, deactivated: [], failDeactivate: 0 };
  const api = {
    calls,
    redactState: "active",
    joinedRooms: async () => Object.keys(rooms),
    roomState: async (roomId) => rooms[roomId],
    makeRoomAdmin: async (roomId, userId) => { calls.admin.push([roomId, userId]); },
    redactUser: async () => { calls.redact++; return `redact-${calls.redact}`; },
    redactStatus: async () => ({ status: api.redactState, failed: 0 }),
    deactivate: async (userId) => {
      if (calls.failDeactivate > 0) { calls.failDeactivate--; throw new SynapseHttpError("deactivate", 502); }
      calls.deactivated.push(userId);
    },
  };
  return api;
}

const member = (userId, ts, membership = "join") => ({ type: "m.room.member", state_key: userId, sender: userId, origin_server_ts: ts, content: { membership } });
const powers = (users, ts = 1) => ({ type: "m.room.power_levels", state_key: "", sender: "@x:example.test", origin_server_ts: ts, content: { users, users_default: 0 } });
const create = (sender, version = "10", extra) => ({ type: "m.room.create", state_key: "", sender, origin_server_ts: 0, content: { room_version: version, ...(extra ? { additional_creators: extra } : {}) } });

async function fixture(t, rooms = {}) {
  const db = await isolatedDatabase(t);
  const stub = await masStub(t);
  const user = `@gone${++sequence}:example.test`;
  const config = { SERVER_NAME: "example.test", MAS_URL: stub.url, MAS_ADMIN_URL: stub.url, MAS_CLIENT_ID: "test-client", MAS_CLIENT_SECRET: "test-only-client-secret", PUBLIC_SITE_URL: "https://bipe.example.test", BIPE_SMTP_HOST: "unused.invalid", BIPE_SMTP_PORT: 587, BIPE_MAIL_FROM: "Bipe <test@example.test>" };
  const mailer = new CapturingMailer(config);
  const synapse = fakeSynapse(rooms);
  const deps = { db, config, pins, mas: new Mas(config), mailer, synapse, bugReportsDir: "/nonexistent-bipe-test", serviceUsers: ["@suporte:example.test"] };
  await db.query("INSERT INTO account_secrets (user_id, device_first, pin_hash) VALUES ($1, true, $2)", [user, goodHash]);
  await db.query("INSERT INTO recovery_emails (user_id, email, verified_at, lang) VALUES ($1, $2, now(), 'en')", [user, `gone${sequence}@example.test`]);
  return { db, deps, stub, synapse, mailer, user };
}

const due = (db, id) => db.query("UPDATE account_deletions SET due_at = now() - interval '1 second', next_try_at = NULL WHERE id = $1", [id]);
const failsWith = (code) => (e) => { assert.equal(e.id, code); return true; };

test("a request needs the senha, waits 72 hours, and shows on every device", async (t) => {
  const f = await fixture(t);
  await assert.rejects(requestDeletion(f.deps, f.user, "PHONE", WRONG_PIN, false), failsWith("pin_wrong"));
  const started = Date.now();
  const d = await requestDeletion(f.deps, f.user, "PHONE", GOOD_PIN, true);
  const hours = (Date.parse(d.due_at) - started) / 3_600_000;
  assert.ok(hours > 71.9 && hours < 72.1, "due 72 hours after the request");
  assert.equal(d.redact_messages, true);
  assert.equal(d.from_this_device, true);
  // A second request changes nothing and costs no PIN try, even with a wrong PIN.
  await assert.rejects(requestDeletion(f.deps, f.user, "PHONE", WRONG_PIN, false), failsWith("deletion_pending"));
  const tries = (await f.db.query("SELECT pin_wrong_tries FROM account_secrets WHERE user_id = $1", [f.user])).rows[0].pin_wrong_tries;
  assert.equal(tries, 0, "the good PIN reset the count and the refused request added none");
  const here = await accountStatus(f.deps, f.user, 2, "PHONE");
  const there = await accountStatus(f.deps, f.user, 2, "LAPTOP");
  const noDevice = await accountStatus(f.deps, f.user, 2, null);
  assert.equal(here.deletion.id, d.id);
  assert.equal(here.deletion.from_this_device, true);
  assert.equal(there.deletion.from_this_device, false);
  assert.equal(noDevice.deletion.from_this_device, false);
  assert.ok(f.mailer.messages.some((m) => m.includes("delete your Bipe account")), "notice to the recovery email");
  const exported = await exportData(f.db, { rowsOf: async () => [] }, f.user);
  assert.equal(exported.account_deletion.id, d.id);
});

test("any device of the account cancels until due_at; nobody else can", async (t) => {
  const f = await fixture(t);
  const d = await requestDeletion(f.deps, f.user, "PHONE", GOOD_PIN, false);
  await assert.rejects(cancelDeletion(f.deps, "@other:example.test", d.id), failsWith("not_found"));
  await cancelDeletion(f.deps, f.user, d.id);
  assert.equal((await accountStatus(f.deps, f.user, 2, "PHONE")).deletion, undefined);
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM account_deletions")).rows[0].n, 0);
  await assert.rejects(cancelDeletion(f.deps, f.user, d.id), failsWith("not_found"));
  // After due_at the cancel is too late.
  const late = await requestDeletion(f.deps, f.user, "PHONE", GOOD_PIN, false);
  await due(f.db, late.id);
  await assert.rejects(cancelDeletion(f.deps, f.user, late.id), failsWith("not_found"));
  assert.equal((await accountStatus(f.deps, f.user, 2, "PHONE")).deletion, undefined);
});

test("nothing runs before due_at", async (t) => {
  const f = await fixture(t);
  await requestDeletion(f.deps, f.user, "PHONE", GOOD_PIN, false);
  assert.equal(await runDueDeletions(f.deps), 0);
  assert.equal(f.synapse.calls.deactivated.length, 0);
  assert.equal(f.stub.deactivated, 0);
});

test("at due_at: rooms handed over, messages redacted, account deactivated, rows gone, @ held", async (t) => {
  const rooms = {
    "!owned:example.test": [create("@x:example.test"), powers({ USER: 100, "@mod:example.test": 50 }), member("USER", 1), member("@old:example.test", 2), member("@mod:example.test", 3)],
    "!shared:example.test": [create("@x:example.test"), powers({ USER: 100, "@co:example.test": 100 }), member("USER", 1), member("@co:example.test", 2)],
  };
  const f0 = { user: `@gone${sequence + 1}:example.test` };
  for (const state of Object.values(rooms)) for (const e of state) {
    if (e.state_key === "USER") e.state_key = f0.user;
    if (e.content.users?.USER) { e.content.users[f0.user] = 100; delete e.content.users.USER; }
  }
  const f = await fixture(t, rooms);
  assert.equal(f.user, f0.user);
  const u = f.user;
  const other = "@shop:example.test";
  await f.db.query("INSERT INTO signups (user_id, account_type) VALUES ($1, 'company')", [u]);
  await f.db.query("INSERT INTO handles (user_id, handle, skeleton) VALUES ($1, 'gone', 'gone')", [u]);
  await f.db.query("INSERT INTO public_profiles (user_id, enabled, name) VALUES ($1, true, 'Gone')", [u]);
  await f.db.query("INSERT INTO terms_acceptances (user_id, version, source) VALUES ($1, '2026-10-01', 'signup')", [u]);
  await f.db.query("INSERT INTO invites (code_hash, uses_left, expires_at, created_by, name) VALUES ('h1', 1, now() + interval '1 day', $1, 'Tia')", [u]);
  await f.db.query("INSERT INTO person_verifications (user_id, level, verified_name, cpf_hash, device_key) VALUES ($1, 'govbr', 'Fulana', 'cpfhash', 'dk')", [u]);
  await f.db.query("INSERT INTO business_claims (user_id, cnpj, status, challenge, verified_at) VALUES ($1, '11222333000181', 'verified', 'c', now())", [u]);
  // The user as a customer of another business, and as a business with its own catálogo.
  await f.db.query(`INSERT INTO catalog_items (id, business_id, kind, name, price, active, sort) VALUES ('svc', $1, 'service', 'Corte', '{}', true, 0), ('mine', $2, 'product', 'Bolo', '{}', true, 0)`, [other, u]);
  await f.db.query(`INSERT INTO agendas (id, business_id, name, active, sort) VALUES ('ag', $1, 'Ana', true, 0)`, [other]);
  const seq = (await f.db.query("SELECT seq FROM agendas WHERE id = 'ag'")).rows[0].seq;
  await f.db.query(
    `INSERT INTO bookings (id, business_id, service_id, agenda_id, agenda_seq, start_at, end_at, busy_start, busy_end, buffer_before_minutes, buffer_after_minutes, status, customer_id, source)
     VALUES ('b1', $1, 'svc', 'ag', $2, now() + interval '1 day', now() + interval '25 hours', now() + interval '1 day', now() + interval '25 hours', 0, 0, 'confirmed', $3, 'customer')`,
    [other, seq, u],
  );
  const d = await requestDeletion(f.deps, u, "PHONE", GOOD_PIN, true);
  await due(f.db, d.id);

  // First tick: rooms handed over, redaction started; Synapse is still redacting.
  assert.equal(await runDueDeletions(f.deps), 0);
  assert.deepEqual(f.synapse.calls.admin, [["!owned:example.test", "@mod:example.test"]]);
  assert.equal(f.synapse.calls.redact, 1);
  assert.equal(f.stub.deactivated, 0, "no deactivation before the redaction ends");
  const waiting = (await f.db.query("SELECT state, step, redact_id FROM account_deletions WHERE id = $1", [d.id])).rows[0];
  assert.deepEqual(waiting, { state: "running", step: "groups", redact_id: "redact-1" });
  assert.equal((await accountStatus(f.deps, u, 2, "PHONE")).deletion, undefined, "a running deletion cannot be cancelled");

  f.synapse.redactState = "completed";
  await due(f.db, d.id);
  assert.equal(await runDueDeletions(f.deps), 1);
  assert.equal(f.synapse.calls.redact, 1, "the redaction is not started twice");
  assert.deepEqual(f.synapse.calls.admin.length, 1, "rooms are not handed over twice");
  assert.equal(f.stub.deactivated, 1);
  assert.deepEqual(f.synapse.calls.deactivated, [u]);

  const count = async (sql) => (await f.db.query(sql, [u])).rows[0].n;
  for (const table of ["signups", "account_secrets", "recovery_emails", "handles", "handle_changes", "public_profiles", "terms_acceptances"]) {
    assert.equal(await count(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`), 0, table);
  }
  assert.equal(await count("SELECT count(*)::int AS n FROM handle_holds WHERE user_id = $1 AND hold_until > now() + interval '89 days'"), 1, "the @ is held 90 days");
  assert.equal(await count("SELECT count(*)::int AS n FROM invites WHERE created_by = $1"), 0);
  assert.equal(await count("SELECT count(*)::int AS n FROM catalog_items WHERE business_id = $1"), 0, "the company's catálogo goes");
  const pv = (await f.db.query("SELECT verified_name, cpf_hash, device_key FROM person_verifications WHERE user_id = $1", [u])).rows[0];
  assert.deepEqual(pv, { verified_name: "", cpf_hash: "cpfhash", device_key: "" }, "only the CPF hash stays");
  const claim = (await f.db.query("SELECT status, reason FROM business_claims WHERE user_id = $1", [u])).rows[0];
  assert.deepEqual(claim, { status: "revoked", reason: "account_deleted" }, "the badge record stays, revoked");
  const booking = (await f.db.query("SELECT customer_id, customer_name, status FROM bookings WHERE id = 'b1'")).rows[0];
  assert.deepEqual(booking, { customer_id: null, customer_name: "Conta apagada", status: "cancelled" });
  const row = (await f.db.query("SELECT state, device_id, done_at IS NOT NULL AS done FROM account_deletions WHERE id = $1", [d.id])).rows[0];
  assert.deepEqual(row, { state: "done", device_id: null, done: true });
  // Nothing to do on the next tick.
  assert.equal(await runDueDeletions(f.deps), 0);
});

test("a failed step runs again later and the job ends the same way", async (t) => {
  const f = await fixture(t);
  const d = await requestDeletion(f.deps, f.user, "PHONE", GOOD_PIN, false);
  await due(f.db, d.id);
  f.synapse.calls.failDeactivate = 1;
  assert.equal(await runDueDeletions(f.deps), 0);
  const failed = (await f.db.query("SELECT state, step, last_error, next_try_at > now() AS later FROM account_deletions WHERE id = $1", [d.id])).rows[0];
  assert.deepEqual(failed, { state: "running", step: "mas", last_error: "synapse: synapse deactivate 502", later: true });
  assert.equal(await runDueDeletions(f.deps), 0, "not before next_try_at");
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM account_secrets WHERE user_id = $1", [f.user])).rows[0].n, 1, "rows stay until deactivation worked");
  await due(f.db, d.id);
  assert.equal(await runDueDeletions(f.deps), 1);
  assert.equal(f.synapse.calls.redact, 0, "no redaction when not asked");
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM account_secrets WHERE user_id = $1", [f.user])).rows[0].n, 0);
});

test("the kept records go after deletionVerificationKeepDays", async (t) => {
  const f = await fixture(t);
  await f.db.query("INSERT INTO person_verifications (user_id, level, verified_name, cpf_hash, device_key) VALUES ($1, 'govbr', '', 'h', '')", [f.user]);
  await f.db.query("INSERT INTO account_deletions (id, user_id, redact_messages, state, due_at, done_at) VALUES ('old', $1, false, 'done', now() - interval '400 days', now() - interval '366 days')", [f.user]);
  await f.db.query("INSERT INTO account_deletions (id, user_id, redact_messages, state, due_at, done_at) VALUES ('new', '@recent:example.test', false, 'done', now(), now())");
  assert.equal(await pruneDeletions(f.db), 1);
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM person_verifications")).rows[0].n, 0);
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM account_deletions")).rows[0].n, 1);
});

test("nextOwner: oldest admin, else oldest member; nothing when the room has another owner", () => {
  const me = "@me:example.test";
  const base = [create("@x:example.test"), member(me, 1)];
  assert.equal(nextOwner([...base, powers({ [me]: 100, "@b:example.test": 50, "@c:example.test": 50 }), member("@a:example.test", 2), member("@c:example.test", 4), member("@b:example.test", 3)], me), "@b:example.test");
  assert.equal(nextOwner([...base, powers({ [me]: 100 }), member("@late:example.test", 9), member("@early:example.test", 5)], me), "@early:example.test");
  assert.equal(nextOwner([...base, powers({ [me]: 100, "@co:example.test": 100 }), member("@co:example.test", 2)], me), null);
  assert.equal(nextOwner([...base, powers({ [me]: 50 }), member("@a:example.test", 2)], me), null, "not an owner");
  assert.equal(nextOwner([...base, powers({ [me]: 100 }), member("@left:example.test", 2, "leave")], me), null, "nobody left to own it");
  assert.equal(nextOwner([...base, powers({ [me]: 100 }), member("@suporte:example.test", 1), member("@a:example.test", 2)], me, new Set(["@suporte:example.test"])), "@a:example.test");
  // Room version 12: the creator is above every level; another creator already owns the room.
  assert.equal(nextOwner([create(me, "12"), member(me, 1), powers({ "@a:example.test": 100 }), member("@a:example.test", 2)], me), "@a:example.test");
  assert.equal(nextOwner([create(me, "12", ["@co:example.test"]), member(me, 1), member("@co:example.test", 2)], me), null);
  // No power levels event: the creator has 100.
  assert.equal(nextOwner([create(me), member(me, 1), member("@a:example.test", 2)], me), "@a:example.test");
});
