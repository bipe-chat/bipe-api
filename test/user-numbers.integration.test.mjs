import assert from "node:assert/strict";
import { test } from "node:test";
import { migrate, MIGRATIONS } from "../dist/db.js";
import { createInvite } from "../dist/invites.js";
import { Mas } from "../dist/mas.js";
import { signup } from "../dist/signup.js";
import { accountCount } from "../dist/staff-reports.js";
import { isolatedDatabase } from "./helpers/database.mjs";
import { masStub } from "./helpers/mas.mjs";

// User numbers (signups.user_number) against a loopback test database and a MAS stub. Synthetic accounts only.
const USER_NUMBERS = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE user_number_counter"));

async function fixture(t) {
  const db = await isolatedDatabase(t);
  const stub = await masStub(t);
  const config = {
    SERVER_NAME: "example.test", MAS_URL: stub.url, MAS_ADMIN_URL: stub.url, MAS_CLIENT_ID: "test-client", MAS_CLIENT_SECRET: "test-only-client-secret",
    APP_ATTEST_APP_IDS: [], APP_ATTEST_ENVIRONMENT: "production", SIGNUP_ATTEST_REQUIRED: false, SIGNUP_TERMS_REQUIRED: false, SIGNUP_INVITE_REQUIRED: false,
  };
  return { db, stub, deps: { db, config, mas: new Mas(config) } };
}

const numbers = async (db) => (await db.query("SELECT user_number FROM signups ORDER BY user_number")).rows.map((r) => Number(r.user_number));
const last = async (db) => Number((await db.query("SELECT last FROM user_number_counter")).rows[0].last);
const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

test("the migration numbers earlier accounts in sign-up order", async (t) => {
  assert.ok(USER_NUMBERS > 0);
  const db = await isolatedDatabase(t, USER_NUMBERS);
  // Inserted out of order: the number follows created_at, then user_id, not the insert order.
  await db.query(`INSERT INTO signups (user_id, created_at) VALUES
    ('@c:example.test', '2026-03-01'), ('@a:example.test', '2026-01-01'), ('@b2:example.test', '2026-02-01'), ('@b1:example.test', '2026-02-01')`);
  await migrate(db);
  const { rows } = await db.query("SELECT user_id, user_number FROM signups ORDER BY user_number");
  assert.deepEqual(rows.map((r) => [r.user_id, Number(r.user_number)]), [
    ["@a:example.test", 1], ["@b1:example.test", 2], ["@b2:example.test", 3], ["@c:example.test", 4],
  ]);
  assert.equal(await last(db), 4);
  await db.query("INSERT INTO signups (user_id) VALUES ('@d:example.test')");
  assert.deepEqual(await numbers(db), range(5));
});

test("concurrent sign-ups get distinct numbers with no gap", async (t) => {
  const f = await fixture(t);
  const made = await Promise.all(range(25).map(() => signup(f.deps, {})));
  assert.equal(new Set(made.map((m) => m.user_id)).size, 25);
  assert.deepEqual(await numbers(f.db), range(25));
  assert.equal(await last(f.db), 25);
});

test("rolled-back sign-ups between concurrent ones leave no gap", async (t) => {
  const f = await fixture(t);
  // Half of the transactions take a number, then fail after it: the counter rolls back with them.
  const attempt = async (i) => {
    const client = await f.db.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO signups (user_id) VALUES ($1)", [`@u${i}:example.test`]);
      await new Promise((r) => setTimeout(r, 5));
      if (i % 2) throw new Error("fail after the number");
      await client.query("COMMIT");
    } catch {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  };
  await Promise.all(range(30).map(attempt));
  assert.deepEqual(await numbers(f.db), range(15));
  assert.equal(await last(f.db), 15);
});

test("a failed sign-up and a replayed sign-up take no number", async (t) => {
  const f = await fixture(t);
  const invite = await createInvite(f.db, 3, 30, "test");
  f.stub.mode = "reject";
  await assert.rejects(signup(f.deps, { invite_code: invite.code }));
  f.stub.mode = "ok";
  const key = "k".repeat(43);
  const made = await signup(f.deps, { invite_code: invite.code, signup_key: key });
  const again = await signup(f.deps, { invite_code: invite.code, signup_key: key });
  assert.equal(again.user_id, made.user_id);
  assert.deepEqual(await numbers(f.db), [1]);
});

test("a deleted account keeps its number unused and the count says so", async (t) => {
  const f = await fixture(t);
  for (const i of range(5)) await f.db.query("INSERT INTO signups (user_id) VALUES ($1)", [`@u${i}:example.test`]);
  await f.db.query("DELETE FROM signups WHERE user_id = '@u5:example.test'");
  await f.db.query("INSERT INTO signups (user_id) VALUES ('@u6:example.test')");
  assert.deepEqual(await numbers(f.db), [1, 2, 3, 4, 6]);
  assert.deepEqual(await accountCount(f.db), { min_cell: 3, last_number: 6, accounts: 5, deleted: null });
});

test("a number never changes and a caller cannot choose one", async (t) => {
  const f = await fixture(t);
  await f.db.query("INSERT INTO signups (user_id, user_number) VALUES ('@a:example.test', 99)");
  assert.deepEqual(await numbers(f.db), [1]);
  await assert.rejects(f.db.query("UPDATE signups SET user_number = 7 WHERE user_id = '@a:example.test'"), /never changes/);
  await f.db.query("UPDATE signups SET account_type = 'company' WHERE user_id = '@a:example.test'");
  assert.deepEqual(await numbers(f.db), [1]);
});
