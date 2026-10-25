import assert from "node:assert/strict";
import { test } from "node:test";
import { hasIndependentRecovery, recordKeychainMove, transferReadiness } from "../dist/transfer.js";
import { isolatedDatabase } from "./helpers/database.mjs";

// bipe#531. Synthetic IDs only. A fake Synapse pool answers the devices query.
const synapseWith = (rows) => ({ query: async () => ({ rows }) });

test("a verified recovery email is a Team-ID-independent factor; a pending one is not", async (t) => {
  const db = await isolatedDatabase(t);
  await db.query("INSERT INTO recovery_emails (user_id, email, verified_at) VALUES ('@a:example.test', 'a@example.test', now())");
  await db.query("INSERT INTO recovery_emails (user_id, pending_email, pending_hash, pending_expires_at) VALUES ('@b:example.test', 'b@example.test', 'h', now() + interval '1 day')");
  assert.equal(await hasIndependentRecovery(db, "@a:example.test"), true);
  assert.equal(await hasIndependentRecovery(db, "@b:example.test"), false);
  assert.equal(await hasIndependentRecovery(db, "@c:example.test"), false);
});

test("a keychain move needs a device from the token and is idempotent", async (t) => {
  const db = await isolatedDatabase(t);
  await assert.rejects(recordKeychainMove(db, "@a:example.test", null), (e) => e.id === "bad_request");
  await recordKeychainMove(db, "@a:example.test", "DEV1");
  await recordKeychainMove(db, "@a:example.test", "DEV1");
  const { rows } = await db.query("SELECT count(*)::int AS n FROM keychain_moves");
  assert.equal(rows[0].n, 1);
});

test("the report keeps iOS devices only and joins moves and factors", async (t) => {
  const db = await isolatedDatabase(t);
  const ios = "Bipe/1.0 (iPhone; iOS 18.0) matrix-rust-sdk";
  const devices = [];
  for (let i = 1; i <= 5; i++) devices.push({ user_id: `@u${i}:example.test`, device_id: "D1", ua: ios });
  devices.push({ user_id: "@u9:example.test", device_id: "D1", ua: "Bipe/1.0 (Android 15)" });
  for (const u of [1, 2, 3]) await recordKeychainMove(db, `@u${u}:example.test`, "D1");
  await db.query("INSERT INTO recovery_emails (user_id, email, verified_at) VALUES ('@u4:example.test', 'u4@example.test', now())");
  await assert.rejects(transferReadiness(db, null, 30), (e) => e.id === "internal");
  const r = await transferReadiness(db, synapseWith(devices), 30);
  assert.equal(r.ios_devices, 5);
  assert.equal(r.ios_accounts, 5);
  assert.equal(r.accounts_covered, 4);
  assert.equal(r.covered_share, 80);
  assert.equal(r.server_factor_share, 20);
});
