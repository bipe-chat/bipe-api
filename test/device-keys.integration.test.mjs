import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { newChallenge } from "../dist/attest.js";
import { passwordOnce, passwordOnceMessage, registerDeviceKey } from "../dist/device-keys.js";
import { Mas } from "../dist/mas.js";
import { newSecret, PinHasher, secretHash } from "../dist/secrets.js";
import { isolatedDatabase } from "./helpers/database.mjs";
import { masStub } from "./helpers/mas.mjs";

// ADR 0283 (bipe#1351): a device key asks for a one-time password. Synthetic keys and accounts only; assertions
// never print passwords.
let sequence = 0;

async function fixture(t, { deviceFirst = true } = {}) {
  const db = await isolatedDatabase(t);
  const stub = await masStub(t);
  const user = `@phone${++sequence}:example.test`;
  const config = { SERVER_NAME: "example.test", MAS_URL: stub.url, MAS_ADMIN_URL: stub.url, MAS_CLIENT_ID: "test-client", MAS_CLIENT_SECRET: "test-only-client-secret" };
  const deps = { db, config, pins: new PinHasher("11".repeat(32)), mas: new Mas(config) };
  await db.query("INSERT INTO account_secrets (user_id, device_first, token_hash) VALUES ($1, $2, $3)", [user, deviceFirst, secretHash(newSecret())]);
  return { db, deps, stub, user };
}

function deviceKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { privateKey, publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
}

const signed = (key, user, device, challenge) =>
  sign("sha256", passwordOnceMessage(user, device, challenge), { key: key.privateKey, dsaEncoding: "der" }).toString("base64");

const failsWith = (code) => (error) => { assert.equal(error.id, code); return true; };

test("the device key gets a new MAS password once per challenge", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const key = deviceKey();
  await registerDeviceKey(f.db, f.user, "PHONE1", key.publicKey);
  const challenge = newChallenge();
  const { password } = await passwordOnce(f.deps, f.user, "PHONE1", challenge, signed(key, f.user, "PHONE1", challenge));
  assert.equal(f.stub.passwordCalls, 1);
  assert.ok(f.stub.passwords.get(f.user.slice(1).split(":")[0]) === password, "MAS has the returned password");
  const row = (await f.db.query("SELECT uses, last_used_at FROM device_keys WHERE user_id = $1", [f.user])).rows[0];
  assert.equal(row.uses, 1);
  assert.ok(row.last_used_at);
  // The challenge is single use.
  await assert.rejects(passwordOnce(f.deps, f.user, "PHONE1", challenge, signed(key, f.user, "PHONE1", challenge)), failsWith("signature_invalid"));
  assert.equal(f.stub.passwordCalls, 1);
});

test("the first key of a device stays; the same key again is accepted", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const key = deviceKey();
  await registerDeviceKey(f.db, f.user, "PHONE1", key.publicKey);
  await registerDeviceKey(f.db, f.user, "PHONE1", key.publicKey);
  await assert.rejects(registerDeviceKey(f.db, f.user, "PHONE1", deviceKey().publicKey), failsWith("device_key_exists"));
  // Another device of the same account registers its own key.
  await registerDeviceKey(f.db, f.user, "PHONE2", deviceKey().publicKey);
  await assert.rejects(registerDeviceKey(f.db, f.user, "PHONE3", "bm90IGEga2V5"), failsWith("bad_request"));
});

test("a wrong signature, another device's key or a missing key gets no password", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const one = deviceKey();
  const two = deviceKey();
  await registerDeviceKey(f.db, f.user, "PHONE1", one.publicKey);
  await registerDeviceKey(f.db, f.user, "PHONE2", two.publicKey);
  let challenge = newChallenge();
  await assert.rejects(passwordOnce(f.deps, f.user, "PHONE1", challenge, signed(two, f.user, "PHONE1", challenge)), failsWith("signature_invalid"));
  challenge = newChallenge();
  await assert.rejects(passwordOnce(f.deps, f.user, "PHONE1", challenge, signed(one, f.user, "PHONE2", challenge)), failsWith("signature_invalid"));
  challenge = newChallenge();
  await assert.rejects(passwordOnce(f.deps, f.user, "PHONE1", challenge, signed(one, "@other:example.test", "PHONE1", challenge)), failsWith("signature_invalid"));
  await assert.rejects(passwordOnce(f.deps, f.user, "PHONE1", "never-issued", signed(one, f.user, "PHONE1", "never-issued")), failsWith("signature_invalid"));
  challenge = newChallenge();
  await assert.rejects(passwordOnce(f.deps, f.user, "PHONE9", challenge, signed(one, f.user, "PHONE9", challenge)), failsWith("device_key_missing"));
  assert.equal(f.stub.passwordCalls, 0);
});

test("a beta account keeps the password its person chose", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, { deviceFirst: false });
  const key = deviceKey();
  await registerDeviceKey(f.db, f.user, "PHONE1", key.publicKey);
  const challenge = newChallenge();
  await assert.rejects(passwordOnce(f.deps, f.user, "PHONE1", challenge, signed(key, f.user, "PHONE1", challenge)), failsWith("device_first_required"));
  assert.equal(f.stub.passwordCalls, 0);
});

test("two phones ask at once: both get a password, one after the other", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const one = deviceKey();
  const two = deviceKey();
  await registerDeviceKey(f.db, f.user, "PHONE1", one.publicKey);
  await registerDeviceKey(f.db, f.user, "PHONE2", two.publicKey);
  const c1 = newChallenge();
  const c2 = newChallenge();
  const results = await Promise.all([
    passwordOnce(f.deps, f.user, "PHONE1", c1, signed(one, f.user, "PHONE1", c1)),
    passwordOnce(f.deps, f.user, "PHONE2", c2, signed(two, f.user, "PHONE2", c2)),
  ]);
  assert.notEqual(results[0].password, results[1].password);
  assert.equal(f.stub.passwordCalls, 2);
});
