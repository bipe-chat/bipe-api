import assert from "node:assert/strict";
import { test } from "node:test";
import { readinessCounts } from "../dist/transfer.js";

// Synthetic IDs only (bipe#531). The report must never return a user ID or a device ID.
const dev = (user, device) => ({ userId: `@u${user}:example.test`, deviceId: `D${device}` });
const key = (user, device) => `@u${user}:example.test\nD${device}`;

test("an account is covered by a server factor or by every active iPhone moved, never by one of two", () => {
  const devices = [dev(1, 1), dev(2, 1), dev(2, 2), dev(3, 1), dev(4, 1), dev(5, 1), dev(5, 2), dev(6, 1)];
  const moved = new Set([key(1, 1), key(2, 1), key(5, 1), key(5, 2), key(6, 1)]);
  const factor = new Set(["@u3:example.test", "@u5:example.test"]);
  const r = readinessCounts(30, { devices, moved, factor });
  assert.equal(r.ios_devices, 8);
  assert.equal(r.ios_devices_moved, 5);
  assert.equal(r.ios_accounts, 6);
  assert.equal(r.accounts_server_factor, null, "2 accounts is under the minimum cell");
  assert.equal(r.accounts_all_devices_moved, 3); // 1, 5, 6; account 2 has one of two
  assert.equal(r.accounts_covered, 4); // 1, 3, 5, 6
  assert.equal(r.accounts_uncovered, null); // 2 and 4
  assert.equal(r.covered_share, 66.7);
  assert.equal(r.server_factor_share, 33.3);
  assert.doesNotMatch(JSON.stringify(r), /@u|"D\d/);
});

test("a window with fewer than the minimum cell of accounts has no shares", () => {
  const r = readinessCounts(30, { devices: [dev(1, 1), dev(2, 1)], moved: new Set(), factor: new Set() });
  assert.equal(r.ios_accounts, null);
  assert.equal(r.covered_share, null);
  assert.equal(r.server_factor_share, null);
  const none = readinessCounts(7, { devices: [], moved: new Set(), factor: new Set() });
  assert.deepEqual([none.days, none.ios_accounts, none.accounts_uncovered, none.covered_share], [7, 0, 0, null]);
});

test("a move recorded for another device of the same user does not cover this device", () => {
  const devices = [dev(1, 1), dev(2, 1), dev(3, 1)];
  const r = readinessCounts(30, { devices, moved: new Set([key(1, 9), key(2, 1), key(3, 1)]), factor: new Set() });
  assert.equal(r.accounts_all_devices_moved, null);
  assert.equal(r.accounts_uncovered, null);
  assert.equal(r.covered_share, 66.7);
});
