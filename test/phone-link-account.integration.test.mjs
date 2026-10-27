import assert from "node:assert/strict";
import { test } from "node:test";
import { existingAccount } from "../dist/handles.js";
import { isolatedDatabase } from "./helpers/database.mjs";

// Staff CLI `phone link`: the argument must name a real account. Synthetic users only.
const SERVER = "example.test";
const mas = (users) => ({
  async userState(username) {
    return username in users ? { id: `mas-${username}`, deactivated: users[username] } : null;
  },
});

test("a handle resolves to its user ID; a full ID passes only with a live account", { timeout: 30000 }, async (t) => {
  const db = await isolatedDatabase(t);
  await db.query("INSERT INTO handles (user_id, handle, skeleton) VALUES ($1, 'mz', 'mz')", [`@x7k2q9:${SERVER}`]);
  const live = mas({ x7k2q9: false, gone: true });

  assert.equal(await existingAccount(db, live, SERVER, "@mz"), `@x7k2q9:${SERVER}`);
  assert.equal(await existingAccount(db, live, SERVER, "@MZ"), `@x7k2q9:${SERVER}`);
  assert.equal(await existingAccount(db, live, SERVER, ` @x7k2q9:${SERVER} `), `@x7k2q9:${SERVER}`);

  await assert.rejects(existingAccount(db, live, SERVER, `@mz:${SERVER}`), /has no account/);
  await assert.rejects(existingAccount(db, live, SERVER, "@nobody"), /no account has the handle/);
  await assert.rejects(existingAccount(db, live, SERVER, "@x7k2q9:other.test"), /is not a user on/);
  await assert.rejects(existingAccount(db, live, SERVER, `@gone:${SERVER}`), /is deactivated/);
  await assert.rejects(existingAccount(db, live, SERVER, `x7k2q9:${SERVER}`), /is not a Matrix user ID/);
});
