import assert from "node:assert/strict";
import { test } from "node:test";
import { mayInvite } from "../dist/messaging.js";
import { Reach } from "../dist/reach.js";
import { raiseBy, ReachTiers, reachSettings, REACH_DEFAULTS } from "../dist/reach-tiers.js";
import { isolatedDatabase } from "./helpers/database.mjs";

// bipe#851: reach tiers and the first-contact budget. Synthetic IDs only.
const SECRET = "reach-test-secret-0123456789abcdef0123456789";
const ana = "@ana:example.test";
const stranger = (i) => `@s${i}:example.test`;

async function setup(t, env = {}, brands = new Set()) {
  const db = await isolatedDatabase(t);
  const reach = new Reach(db, { secret: SECRET, serverName: "example.test" });
  const tiers = new ReachTiers(db, reach, reachSettings(env), async (id) => (brands.has(id) ? { name: "Loja" } : null));
  return { db, reach, tiers };
}

const signup = (db, user, { attested = true, type = "personal", daysAgo = 30 } = {}) =>
  db.query("INSERT INTO signups (user_id, account_type, attested, created_at) VALUES ($1, $2, $3, now() - make_interval(days => $4))", [user, type, attested, daysAgo]);

test("settings: the environment wins, every unset value is named", () => {
  const s = reachSettings({ REACH_BUDGETS: "new=2,slowed=0", REACH_NEW_DAYS: 3, REACH_LIMITS: false });
  assert.equal(s.budgets.new, 2);
  assert.equal(s.budgets.slowed, 0);
  assert.equal(s.budgets.normal, REACH_DEFAULTS.budgets.normal);
  assert.equal(s.newDays, 3);
  assert.equal(s.enforce, false);
  assert.ok(s.defaulted.includes("REACH_BUDGETS.normal") && !s.defaulted.includes("REACH_BUDGETS.new") && !s.defaulted.includes("REACH_NEW_DAYS"));
  assert.equal(reachSettings({}).enforce, true);
});

test("tiers: unattested, new, normal, verified, company", async (t) => {
  const { db, tiers } = await setup(t, {}, new Set(["@loja:example.test"]));
  assert.equal(await tiers.tierOf("@nosignup:example.test"), "unattested");
  await signup(db, "@old:example.test", { attested: null });
  assert.equal(await tiers.tierOf("@old:example.test"), "unattested", "a sign-up from before the column");
  await signup(db, "@plain:example.test", { attested: false });
  assert.equal(await tiers.tierOf("@plain:example.test"), "unattested");
  await signup(db, "@young:example.test", { daysAgo: 2 });
  assert.equal(await tiers.tierOf("@young:example.test"), "new");
  await signup(db, ana);
  assert.equal(await tiers.tierOf(ana), "normal");
  await db.query("INSERT INTO person_verifications (user_id, level, verified_name, cpf_hash, device_key, verified_at) VALUES ($1, 'govbr', 'Ana', 'h', 'k', now())", [ana]);
  assert.equal(await tiers.tierOf(ana), "verified");
  await signup(db, "@loja:example.test", { attested: null, type: "company" });
  assert.equal(await tiers.tierOf("@loja:example.test"), "company");
  assert.equal(raiseBy("new"), "verify");
  assert.equal(raiseBy("slowed"), "wait");
  assert.equal(raiseBy("company"), null);
});

test("slowed: blocks and reports on enough first contacts, above the floor rate", async (t) => {
  const { db, tiers } = await setup(t);
  // Three senders with a low rate set the median (the median is cached for an hour, so they go in first).
  for (const peer of ["@p1:example.test", "@p2:example.test", "@p3:example.test"]) {
    await db.query("INSERT INTO reach_daily (user_id, day, sent, blocked) VALUES ($1, current_date - 2, 40, 1)", [peer]);
  }
  await signup(db, ana);
  await db.query("INSERT INTO reach_daily (user_id, day, sent, blocked, reported) VALUES ($1, current_date - 1, 12, 2, 1)", [ana]);
  assert.equal(await tiers.tierOf(ana), "slowed");
  await signup(db, "@few:example.test");
  await db.query("INSERT INTO reach_daily (user_id, day, sent, blocked) VALUES ($1, current_date - 1, 5, 5)", ["@few:example.test"]);
  assert.equal(await tiers.tierOf("@few:example.test"), "normal", "under slowedMinContacts");
  await signup(db, "@good:example.test");
  await db.query("INSERT INTO reach_daily (user_id, day, sent, blocked) VALUES ($1, current_date - 1, 40, 1)", ["@good:example.test"]);
  assert.equal(await tiers.tierOf("@good:example.test"), "normal");
});

test("the budget refuses the next first contact, never a contact or an invite pair", async (t) => {
  const { db, reach, tiers } = await setup(t, { REACH_BUDGETS: "normal=3" });
  await signup(db, ana);
  for (let i = 0; i < 3; i++) assert.equal((await mayInvite(db, ana, stranger(i), false, { reach, tiers, roomId: `!r${i}:example.test` })).allow, true);
  assert.deepEqual(await mayInvite(db, ana, stranger(9), false, { reach, tiers, roomId: "!r9:example.test" }), { allow: false, policy: "everyone", reason: "reach_limit" });
  assert.equal((await db.query("SELECT count(*)::int AS n FROM first_contacts")).rows[0].n, 3, "a refused invite is not recorded");
  // A contact (shared room, the reply to a stranger who wrote first) and an invite pair are never limited.
  assert.equal((await mayInvite(db, ana, stranger(10), true, { reach, tiers })).allow, true);
  const { rows: [inv] } = await db.query("INSERT INTO invites (code_hash, uses_left, expires_at, created_by) VALUES ('h', 0, now() + interval '1 day', $1) RETURNING id", [ana]);
  await db.query("INSERT INTO signups (user_id, invite_id, attested) VALUES ($1, $2, true)", [stranger(11), inv.id]);
  assert.equal((await mayInvite(db, ana, stranger(11), false, { reach, tiers })).allow, true);
  // A policy refusal stays a policy refusal.
  await db.query("INSERT INTO messaging_policies (user_id, policy) VALUES ($1, 'contacts')", [stranger(12)]);
  assert.deepEqual(await mayInvite(db, ana, stranger(12), false, { reach, tiers }), { allow: false, policy: "contacts" });
  const status = await tiers.status(ana);
  assert.equal(status.tier, "normal");
  assert.equal(status.budget, 3);
  assert.equal(status.used, 3);
  assert.equal(status.raise_by, "verify");
  assert.ok(Date.parse(status.resets_at) > Date.now());
});

test("the window rolls: a first contact older than windowHours gives its unit back", async (t) => {
  const { db, reach, tiers } = await setup(t, { REACH_BUDGETS: "normal=1" });
  await signup(db, ana);
  await reach.record(ana, stranger(1), "!old:example.test", new Date(Date.now() - 25 * 3_600_000));
  assert.equal((await mayInvite(db, ana, stranger(2), false, { reach, tiers })).allow, true);
  assert.equal((await mayInvite(db, ana, stranger(3), false, { reach, tiers })).allow, false);
  const status = await tiers.status(ana);
  assert.equal(status.used, 1);
  assert.equal(status.resets_at === null, false);
});

test("parallel first contacts never pass the budget", async (t) => {
  const { db, reach, tiers } = await setup(t, { REACH_BUDGETS: "normal=4" });
  await signup(db, ana);
  const answers = await Promise.all(Array.from({ length: 10 }, (_, i) => mayInvite(db, ana, stranger(i), false, { reach, tiers })));
  assert.equal(answers.filter((a) => a.allow).length, 4);
});

test("REACH_LIMITS=off records and allows; no first-contact record allows and answers reach_unavailable", async (t) => {
  const { db, reach, tiers } = await setup(t, { REACH_BUDGETS: "normal=0", REACH_LIMITS: false });
  await signup(db, ana);
  assert.equal((await mayInvite(db, ana, stranger(1), false, { reach, tiers })).allow, true);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM first_contacts")).rows[0].n, 1);
  const off = new Reach(db, { serverName: "example.test" });
  const offTiers = new ReachTiers(db, off, reachSettings({ REACH_BUDGETS: "normal=0" }), async () => null);
  assert.equal((await mayInvite(db, ana, stranger(2), false, { reach: off, tiers: offTiers })).allow, true);
  await assert.rejects(offTiers.status(ana), (e) => e.reason === "reach_unavailable");
});
