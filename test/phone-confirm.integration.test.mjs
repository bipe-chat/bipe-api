import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { exportData } from "../dist/export.js";
import { blockMove, linkPhone, loadPhoneKeys, lookupContacts, myPhone, PhoneHasher, pruneLapsedLinks, recordProof, rekeyPhones, runPhoneMoves, setDiscovery, unlinkPhone } from "../dist/phones.js";
import { ProfileFacts } from "../dist/profile-facts.js";
import { phoneRules } from "../dist/registry.js";
import { isolatedDatabase } from "./helpers/database.mjs";

// Yearly confirmation of a linked number (bipe#470). Synthetic numbers and users only.
const hasher = new PhoneHasher("44".repeat(32));
const NUMBER = "+5511987654321";

test("confirm_by is the last proof plus linkConfirmMonths, and lookup skips a link past it", { timeout: 30000 }, async (t) => {
  const db = await isolatedDatabase(t);
  const owner = "@owner:example.test";
  const finder = "@finder:example.test";
  await linkPhone(db, hasher, owner, NUMBER, false);
  await setDiscovery(db, owner, true);
  const state = await myPhone(db, hasher, owner);
  const confirmBy = new Date(state.confirm_by);
  const expected = new Date(state.linked_at);
  expected.setMonth(expected.getMonth() + phoneRules.linkConfirmMonths);
  assert.equal(confirmBy.getTime(), expected.getTime());
  assert.equal((await lookupContacts(db, hasher, finder, [NUMBER])).matches.length, 1);

  await db.query("UPDATE phone_links SET confirmed_at = now() - make_interval(months => $1, days => 1) WHERE user_id = $2", [phoneRules.linkConfirmMonths, owner]);
  assert.ok(new Date((await myPhone(db, hasher, owner)).confirm_by) < new Date());
  assert.equal((await lookupContacts(db, hasher, finder, [NUMBER])).matches.length, 0);
});

// ADR 0191, bipe#787: the owner gets the own number back; nobody else does, and it goes with the link.
test("the linked number is stored encrypted and goes back only to its owner", { timeout: 30000 }, async (t) => {
  const db = await isolatedDatabase(t);
  const owner = "@owner:example.test";
  const finder = "@finder:example.test";
  await linkPhone(db, hasher, owner, "+55 (11) 98765-4321", false);
  await setDiscovery(db, owner, true);

  const stored = (await db.query("SELECT number_enc FROM phone_links WHERE user_id = $1", [owner])).rows[0].number_enc;
  assert.ok(Buffer.isBuffer(stored) && !stored.toString("latin1").includes("98765"), "the number is not stored in clear");
  assert.equal((await myPhone(db, hasher, owner)).number, NUMBER);
  assert.equal((await myPhone(db, new PhoneHasher("55".repeat(32)), owner)).number, null, "another key does not open it");
  assert.equal((await myPhone(db, hasher, finder)).number, undefined, "no link, no number");
  const lookup = await lookupContacts(db, hasher, finder, [NUMBER]);
  assert.deepEqual(Object.keys(lookup.matches[0]).sort(), ["phone", "user_id"]);
  const exported = await exportData(db, { rowsOf: async () => [] }, owner, new Date(), hasher);
  assert.equal(exported.phone_link.number, NUMBER);
  assert.equal(exported.phone_link.number_enc, undefined);

  // A link made before ADR 0191 has no stored number: the state only.
  await db.query("UPDATE phone_links SET number_enc = NULL WHERE user_id = $1", [owner]);
  const old = await myPhone(db, hasher, owner);
  assert.equal(old.linked, true);
  assert.equal(old.number, null);

  await linkPhone(db, hasher, owner, NUMBER, false);
  await unlinkPhone(db, owner);
  assert.equal((await db.query("SELECT 1 FROM phone_links WHERE user_id = $1", [owner])).rowCount, 0);
  assert.equal((await myPhone(db, hasher, owner)).linked, false);
});

// ADR 0197: the Brazilian core proves only +55. A foreign number is refused and nobody finds it.
test("a number from another country is not linked and lookup finds nothing", { timeout: 30000 }, async (t) => {
  const db = await isolatedDatabase(t);
  const owner = "@owner:example.test";
  await assert.rejects(linkPhone(db, hasher, owner, "+351 912 345 678", false), /does not prove/);
  assert.equal((await db.query("SELECT 1 FROM phone_links WHERE user_id = $1", [owner])).rowCount, 0);
  assert.equal((await lookupContacts(db, hasher, "@finder:example.test", ["+351912345678"])).matches.length, 0);
});

// bipe#469: a number held by another account moves only after the hold, and the holder can block it.
const HOLDER = "@holder:example.test";
const NEWCOMER = "@newcomer:example.test";
const FINDER = "@finder:example.test";

async function heldNumber(t) {
  const db = await isolatedDatabase(t);
  await linkPhone(db, hasher, HOLDER, NUMBER, false);
  // Discovery is opt-in (bipe#402): both accounts allow it, so the lookup shows who holds the number.
  await setDiscovery(db, HOLDER, true);
  await setDiscovery(db, NEWCOMER, true);
  return db;
}
const holderOf = async (db) => (await lookupContacts(db, hasher, FINDER, [NUMBER])).matches[0]?.user_id;
const recording = () => {
  const sent = [];
  return { sent, notify: async (userId, key) => void sent.push([userId, key]) };
};
const due = (db) => db.query("UPDATE phone_moves SET ends_at = now() - interval '1 minute' WHERE state = 'waiting'");

test("a second proof starts a move: the holder stays until it ends and is alerted first", { timeout: 30000 }, async (t) => {
  const db = await heldNumber(t);
  await assert.rejects(linkPhone(db, hasher, NEWCOMER, NUMBER, false), /use --force/);
  assert.equal((await linkPhone(db, hasher, NEWCOMER, NUMBER, true)).outcome, "moving");
  assert.equal(await holderOf(db), HOLDER);
  const out = (await myPhone(db, hasher, HOLDER)).move;
  assert.deepEqual([out.direction, out.state], ["out", "waiting"]);
  const incoming = (await myPhone(db, hasher, NEWCOMER)).move;
  assert.deepEqual([incoming.direction, incoming.state], ["in", "waiting"]);
  assert.ok(!JSON.stringify(out).includes("newcomer") && !JSON.stringify(incoming).includes("holder"), "the other account stays hidden");

  // Past the date with no alert sent: the number stays.
  await due(db);
  const failing = async () => { throw new Error("no bot"); };
  await runPhoneMoves(db, failing);
  assert.equal(await holderOf(db), HOLDER);

  const { sent, notify } = recording();
  await runPhoneMoves(db, notify);
  assert.deepEqual(sent, [[HOLDER, "bipe_phone_move_alert"]]);
  assert.ok(new Date((await myPhone(db, hasher, HOLDER)).move.ends) > new Date(), "the hold counts from the alert");
  assert.equal(await holderOf(db), HOLDER);

  await due(db);
  await runPhoneMoves(db, notify);
  assert.equal(await holderOf(db), NEWCOMER);
  assert.equal((await myPhone(db, hasher, HOLDER)).linked, false);
  assert.equal((await myPhone(db, hasher, NEWCOMER)).number, NUMBER);
  assert.deepEqual(sent.slice(1), [[HOLDER, "bipe_phone_move_done_out"], [NEWCOMER, "bipe_phone_move_done_in"]]);
});

test("the holder blocks: the number stays, and the same account cannot start again at once", { timeout: 30000 }, async (t) => {
  const db = await heldNumber(t);
  await linkPhone(db, hasher, NEWCOMER, NUMBER, true);
  const { id } = (await myPhone(db, hasher, HOLDER)).move;
  await assert.rejects(blockMove(db, NEWCOMER, id));
  await blockMove(db, HOLDER, id);
  await assert.rejects(blockMove(db, HOLDER, id));

  const { sent, notify } = recording();
  await runPhoneMoves(db, notify);
  assert.deepEqual(sent, [[NEWCOMER, "bipe_phone_move_blocked"]]);
  assert.equal(await holderOf(db), HOLDER);
  assert.equal((await myPhone(db, hasher, HOLDER)).move, undefined);
  assert.equal((await myPhone(db, hasher, NEWCOMER)).move.state, "blocked");
  assert.deepEqual(await linkPhone(db, hasher, NEWCOMER, NUMBER, true), { outcome: "held", reason: "blocked" });
});

test("the holder unlinks during a move: the number goes to the new account at once", { timeout: 30000 }, async (t) => {
  const db = await heldNumber(t);
  await linkPhone(db, hasher, NEWCOMER, NUMBER, true);
  await unlinkPhone(db, HOLDER);
  assert.equal(await holderOf(db), NEWCOMER);
  assert.equal((await myPhone(db, hasher, NEWCOMER)).move, undefined);
});

test("the new account unlinks during a move: the move is withdrawn", { timeout: 30000 }, async (t) => {
  const db = await heldNumber(t);
  await linkPhone(db, hasher, NEWCOMER, NUMBER, true);
  await unlinkPhone(db, NEWCOMER);
  assert.equal((await myPhone(db, hasher, HOLDER)).move, undefined);
  assert.equal(await holderOf(db), HOLDER);
});

test("an SMS proof never starts a move on a Pix-proved link, and the holder's own proof only confirms", { timeout: 30000 }, async (t) => {
  const db = await heldNumber(t);
  await db.query("UPDATE phone_links SET method = 'pix' WHERE user_id = $1", [HOLDER]);
  const hash = hasher.hash(NUMBER);
  const sealed = hasher.seal(NUMBER);
  assert.deepEqual(await recordProof(db, NEWCOMER, hash, sealed, "sms"), { outcome: "held", reason: "pix_link" });
  assert.deepEqual(await recordProof(db, HOLDER, hash, sealed, "sms"), { outcome: "confirmed" });
  assert.equal((await myPhone(db, hasher, HOLDER)).method, "pix");
  assert.equal((await recordProof(db, NEWCOMER, hash, sealed, "pix")).outcome, "moving");
  assert.deepEqual(await recordProof(db, FINDER, hash, sealed, "pix"), { outcome: "held", reason: "move_waiting" });
});

test("staff --now moves the number at once", { timeout: 30000 }, async (t) => {
  const db = await heldNumber(t);
  await linkPhone(db, hasher, NEWCOMER, NUMBER, true);
  assert.deepEqual(await linkPhone(db, hasher, FINDER, NUMBER, false, true), { outcome: "linked" });
  assert.equal((await myPhone(db, hasher, FINDER)).number, NUMBER);
  assert.equal((await myPhone(db, hasher, HOLDER)).linked, false);
  assert.equal((await myPhone(db, hasher, NEWCOMER)).move, undefined);
});

// bipe#161: contacts learn of a move from the facts and the lookup. Nobody's matches are stored.
test("a finished move shows in the facts and in the lookup, and no match list exists", { timeout: 30000 }, async (t) => {
  const db = await heldNumber(t);
  await setDiscovery(db, HOLDER, true);
  assert.equal((await lookupContacts(db, hasher, FINDER, [NUMBER])).matches[0].moved_at, undefined);
  await linkPhone(db, hasher, NEWCOMER, NUMBER, true);
  const { notify } = recording();
  await runPhoneMoves(db, notify);
  await due(db);
  await runPhoneMoves(db, notify);

  const [match] = (await lookupContacts(db, hasher, FINDER, [NUMBER])).matches;
  assert.equal(match.user_id, NEWCOMER);
  assert.ok(Date.parse(match.moved_at) > 0);

  const { facts } = await new ProfileFacts(db, { serverName: "example.test" }).facts([HOLDER, NEWCOMER]);
  const of = (id) => facts.find((f) => f.user_id === id);
  assert.equal(of(HOLDER).number_moved_out.length, 1);
  assert.equal(of(HOLDER).number_moved_in.length, 0);
  assert.equal(of(NEWCOMER).number_moved_in.length, 1);
  assert.equal(of(NEWCOMER).number_moved_out.length, 0);
});

// ADR 0260: the phone key lives in a file, and a rotation re-keys at start.
test("the key file wins over the variable, and a short file falls back", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "phone-key-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = "e".repeat(32);
  assert.deepEqual(loadPhoneKeys(undefined, env), { current: env });
  assert.deepEqual(loadPhoneKeys(dir, env), { current: env });
  assert.deepEqual(loadPhoneKeys(dir, undefined), {});
  writeFileSync(join(dir, "hmac-key"), `${"a".repeat(32)}\n`);
  assert.deepEqual(loadPhoneKeys(dir, env), { current: "a".repeat(32) });
  writeFileSync(join(dir, "hmac-key-previous"), "b".repeat(32));
  assert.deepEqual(loadPhoneKeys(dir, env), { current: "a".repeat(32), previous: "b".repeat(32) });
  writeFileSync(join(dir, "hmac-key"), "short");
  assert.equal(loadPhoneKeys(dir, undefined).current, undefined);
});

test("a rotation re-keys links and moves, drops what cannot open, and a second run changes nothing", { timeout: 30000 }, async (t) => {
  const db = await heldNumber(t);
  await linkPhone(db, hasher, NEWCOMER, NUMBER, true);
  const other = "@other:example.test";
  await linkPhone(db, hasher, other, "+5511912345678", false);
  await db.query("UPDATE phone_links SET number_enc = NULL WHERE user_id = $1", [other]);

  const next = new PhoneHasher("66".repeat(32));
  assert.deepEqual(await rekeyPhones(db, next, hasher), { rekeyed: 2, dropped: 1 });
  assert.deepEqual(await rekeyPhones(db, next, hasher), { rekeyed: 0, dropped: 0 });

  assert.equal((await lookupContacts(db, next, FINDER, [NUMBER])).matches[0].user_id, HOLDER);
  assert.equal((await lookupContacts(db, hasher, FINDER, [NUMBER])).matches.length, 0);
  assert.equal((await myPhone(db, next, HOLDER)).number, NUMBER);
  assert.equal((await myPhone(db, next, other)).linked, false);

  // The waiting move survives and ends with a link that the new key opens.
  const { notify } = recording();
  await runPhoneMoves(db, notify);
  await due(db);
  await runPhoneMoves(db, notify);
  assert.equal((await myPhone(db, next, NEWCOMER)).number, NUMBER);
  assert.equal((await lookupContacts(db, next, FINDER, [NUMBER])).matches[0].user_id, NEWCOMER);
});

// bipe#402: discovery is opt-in, and a link that stopped matching goes 30 days later.
test("a linked number is not found until its owner allows discovery", { timeout: 30000 }, async (t) => {
  const db = await isolatedDatabase(t);
  const owner = "@owner:example.test";
  await linkPhone(db, hasher, owner, NUMBER, false);
  assert.equal((await lookupContacts(db, hasher, "@finder:example.test", [NUMBER])).matches.length, 0);
  assert.equal((await myPhone(db, hasher, owner)).discoverable_by_phone, false);
  await setDiscovery(db, owner, true);
  assert.equal((await lookupContacts(db, hasher, "@finder:example.test", [NUMBER])).matches.length, 1);
});

test("a lapsed link stays 30 days, then the prune deletes it", { timeout: 30000 }, async (t) => {
  const db = await isolatedDatabase(t);
  const owner = "@owner:example.test";
  await linkPhone(db, hasher, owner, NUMBER, false);
  await db.query("UPDATE phone_links SET confirmed_at = now() - make_interval(months => $1, days => 29) WHERE user_id = $2", [phoneRules.linkConfirmMonths, owner]);
  assert.equal(await pruneLapsedLinks(db), 0);
  await db.query("UPDATE phone_links SET confirmed_at = now() - make_interval(months => $1, days => 31) WHERE user_id = $2", [phoneRules.linkConfirmMonths, owner]);
  assert.equal(await pruneLapsedLinks(db), 1);
  assert.equal((await myPhone(db, hasher, owner)).linked, false);
});
