import assert from "node:assert/strict";
import { test } from "node:test";
import { exportData } from "../dist/export.js";
import { linkPhone, lookupContacts, myPhone, PhoneHasher, setDiscovery, unlinkPhone } from "../dist/phones.js";
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
