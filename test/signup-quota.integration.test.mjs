import assert from "node:assert/strict";
import { test } from "node:test";
import { createInvite } from "../dist/invites.js";
import { Mas } from "../dist/mas.js";
import { signup } from "../dist/signup.js";
import { SignupLimits } from "../dist/signup-limits.js";
import { isolatedDatabase } from "./helpers/database.mjs";
import { masStub } from "./helpers/mas.mjs";

// bipe#395 against a loopback test database and a MAS stub. Synthetic accounts only; assertions print no secrets.
const failsWith = (id) => (error) => { assert.equal(error.id, id); return true; };

async function fixture(t, maxCreations) {
  const db = await isolatedDatabase(t);
  const stub = await masStub(t);
  const config = {
    SERVER_NAME: "example.test", MAS_URL: stub.url, MAS_ADMIN_URL: stub.url, MAS_CLIENT_ID: "test-client", MAS_CLIENT_SECRET: "test-only-client-secret",
    APP_ATTEST_APP_IDS: [], APP_ATTEST_ENVIRONMENT: "production", SIGNUP_ATTEST_REQUIRED: false, SIGNUP_TERMS_REQUIRED: false, SIGNUP_INVITE_REQUIRED: true,
  };
  const deps = { db, config, mas: new Mas(config) };
  return { db, stub, deps, limits: new SignupLimits(maxCreations) };
}

const usesLeft = async (db, id) => Number((await db.query("SELECT uses_left FROM invites WHERE id = $1", [id])).rows[0].uses_left);

test("invalid invites do not use the creation that a valid invite needs", async (t) => {
  const f = await fixture(t, 1);
  for (let i = 0; i < 40; i++) {
    await assert.rejects(signup(f.deps, { invite_code: "ABCD-EFGH-JKMN" }, f.limits.creation), failsWith("invite_invalid"));
  }
  const invite = await createInvite(f.db, 1, 30, "test");
  const made = await signup(f.deps, { invite_code: invite.code }, f.limits.creation);
  assert.match(made.user_id, /^@[a-z2-7]{12}:example\.test$/);
  assert.equal(await usesLeft(f.db, invite.id), 0);
});

test("a full hour refuses after the invite check and gives the invite use back", async (t) => {
  const f = await fixture(t, 1);
  const first = await createInvite(f.db, 1, 30, "test");
  const second = await createInvite(f.db, 1, 30, "test");
  await signup(f.deps, { invite_code: first.code }, f.limits.creation);
  await assert.rejects(signup(f.deps, { invite_code: second.code }, f.limits.creation), failsWith("rate_limited"));
  assert.equal(await usesLeft(f.db, second.id), 1);
  assert.equal(f.stub.deactivated, 0, "no MAS user is made when the hour is full");
});

test("a sign-up that fails after the creation was taken gives it back", async (t) => {
  const f = await fixture(t, 1);
  const invite = await createInvite(f.db, 2, 30, "test");
  f.stub.mode = "reject";
  await assert.rejects(signup(f.deps, { invite_code: invite.code }, f.limits.creation), failsWith("internal"));
  assert.equal(f.stub.deactivated, 1);
  assert.equal(await usesLeft(f.db, invite.id), 2);
  await signup(f.deps, { invite_code: invite.code }, f.limits.creation);
});

test("a replay with the same signup key takes no second creation", async (t) => {
  const f = await fixture(t, 1);
  const invite = await createInvite(f.db, 1, 30, "test");
  const key = "k".repeat(43);
  const made = await signup(f.deps, { invite_code: invite.code, signup_key: key }, f.limits.creation);
  const again = await signup(f.deps, { invite_code: invite.code, signup_key: key }, f.limits.creation);
  assert.equal(again.user_id, made.user_id);
});
