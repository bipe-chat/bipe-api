import assert from "node:assert/strict";
import { test } from "node:test";
import { linkPhone, lookupContacts, myPhone, PhoneHasher, setDiscovery } from "../dist/phones.js";
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
  const state = await myPhone(db, owner);
  const confirmBy = new Date(state.confirm_by);
  const expected = new Date(state.linked_at);
  expected.setMonth(expected.getMonth() + phoneRules.linkConfirmMonths);
  assert.equal(confirmBy.getTime(), expected.getTime());
  assert.equal((await lookupContacts(db, hasher, finder, [NUMBER])).matches.length, 1);

  await db.query("UPDATE phone_links SET confirmed_at = now() - make_interval(months => $1, days => 1) WHERE user_id = $2", [phoneRules.linkConfirmMonths, owner]);
  assert.ok(new Date((await myPhone(db, owner)).confirm_by) < new Date());
  assert.equal((await lookupContacts(db, hasher, finder, [NUMBER])).matches.length, 0);
});
