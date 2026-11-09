import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Badges } from "../dist/badges.js";
import { isolatedDatabase, testDatabaseUrl } from "./helpers/database.mjs";

// Every proof of an account (ADR 0275, bipe#1239). Synthetic accounts only.
const ANA = "@ana:example.test";
const MSK = "cmVzZWxsZXItbWFzdGVyLWtleS0wMS1mb3ItdGVzdHM"; // 43 characters, as Synapse stores an Ed25519 key
const NEW_MSK = "bm92YS1jaGF2ZS1tZXN0cmEtZGEtYW5hLXBhcmEtdGU";

async function setup(t) {
  const db = await isolatedDatabase(t);
  const { rows: [{ schema }] } = await db.query("SELECT current_schema() AS schema");
  await db.query("CREATE TABLE e2e_cross_signing_keys (user_id text, keytype text, keydata text, stream_id bigint)");
  const keyDir = mkdtempSync(join(tmpdir(), "bipe-badge-"));
  t.after(() => rmSync(keyDir, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(join(keyDir, "key.pem"), privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(join(keyDir, "kid"), "prod-2026-10");
  const url = testDatabaseUrl(process.env.BIPE_TEST_DATABASE_URL);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const badges = new Badges(db, { keyDir, synapseUrl: url.href });
  t.after(() => badges.close());
  return { db, badges, publicKey };
}

const proof = (db, level, name = "Ana Souza", masterKey = MSK) =>
  db.query("INSERT INTO person_verifications (user_id, level, verified_name, master_key) VALUES ($1, $2, $3, $4)", [ANA, level, name, masterKey]);

function payloadOf(envelope, publicKey) {
  const bytes = Buffer.from(envelope.payload, "base64url");
  assert.ok(verify(null, bytes, publicKey, Buffer.from(envelope.sig, "base64url")), "the signature verifies");
  return JSON.parse(bytes);
}

test("two proofs give two envelopes that verify, strongest first; the single answer is the strongest", async (t) => {
  const { db, badges, publicKey } = await setup(t);
  await proof(db, "pix");
  await proof(db, "govbr");
  const envelopes = await badges.proofsFor(ANA);
  const payloads = envelopes.map((e) => payloadOf(e, publicKey));
  assert.deepEqual(payloads.map((p) => p.lvl), ["govbr", "pix"]);
  for (const p of payloads) {
    assert.equal(p.sub, ANA);
    assert.equal(p.msk, MSK);
    assert.equal(p.dev, undefined, "ADR 0239: msk, never dev");
  }
  const single = await badges.forUser(ANA);
  assert.equal(single.status, 200);
  assert.equal(payloadOf(single.envelope, publicKey).lvl, "govbr");
});

test("one proof gives one envelope; no proof gives none and a 404", async (t) => {
  const { db, badges, publicKey } = await setup(t);
  assert.deepEqual(await badges.proofsFor(ANA), []);
  assert.equal((await badges.forUser(ANA)).status, 404);
  await proof(db, "pix");
  const envelopes = await badges.proofsFor(ANA);
  assert.deepEqual(envelopes.map((e) => payloadOf(e, publicKey).lvl), ["pix"]);
});

test("a theft mark empties both answers", async (t) => {
  const { db, badges } = await setup(t);
  await proof(db, "pix");
  await proof(db, "govbr");
  await db.query("INSERT INTO theft_marks (user_id, marked_by) VALUES ($1, '@bia:example.test')", [ANA]);
  assert.deepEqual(await badges.proofsFor(ANA), []);
  assert.deepEqual(await badges.forUser(ANA), { status: 410, reason: "stolen" });
});

test("a revoked company claim empties both answers", async (t) => {
  const { db, badges } = await setup(t);
  await proof(db, "pix");
  await db.query("INSERT INTO business_claims (user_id, scheme, org_id, status, challenge, reason) VALUES ($1, 'br.cnpj', '11222333000181', 'revoked', 'x', 'staff')", [ANA]);
  assert.deepEqual(await badges.proofsFor(ANA), []);
  assert.deepEqual(await badges.forUser(ANA), { status: 410, reason: "staff" });
});

test("a proof keeps its master key after a reset, so the apps show the suspended state (ADR 0239)", async (t) => {
  const { db, badges, publicKey } = await setup(t);
  await proof(db, "govbr");
  await db.query("INSERT INTO e2e_cross_signing_keys VALUES ($1, 'master', $2, 9)", [
    ANA,
    JSON.stringify({ user_id: ANA, usage: ["master"], keys: { [`ed25519:${NEW_MSK}`]: NEW_MSK } }),
  ]);
  assert.equal(await badges.currentMasterKey(ANA), NEW_MSK);
  const [envelope] = await badges.proofsFor(ANA);
  assert.equal(payloadOf(envelope, publicKey).msk, MSK);
});

test("a proof with no name or no master key signs nothing (fail closed)", async (t) => {
  const { db, badges } = await setup(t);
  await proof(db, "govbr", "");
  await proof(db, "pix", "Ana Souza", "");
  assert.deepEqual(await badges.proofsFor(ANA), []);
  assert.equal((await badges.forUser(ANA)).status, 404);
});

test("one CPF, one account: a second account with the same hash fails on the index", async (t) => {
  const { db } = await setup(t);
  await db.query("INSERT INTO person_identities (user_id, scheme, dedupe_hash) VALUES ($1, 'br.govbr', 'h')", [ANA]);
  await assert.rejects(
    db.query("INSERT INTO person_identities (user_id, scheme, dedupe_hash) VALUES ('@bia:example.test', 'br.govbr', 'h')"),
    (e) => e.code === "23505",
  );
});
