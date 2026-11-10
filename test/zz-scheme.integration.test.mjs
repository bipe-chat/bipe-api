import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Badges } from "../dist/badges.js";
import { createClaim, proveControl, runScan } from "../dist/business.js";
import { recordPersonProof } from "../dist/person-proof.js";
import { registerTestScheme } from "../dist/schemes.js";
import { isolatedDatabase, testDatabaseUrl } from "./helpers/database.mjs";

// bipe-chat/bipe#1195 (ADR 0272): a person and a company of the test-only region zz go through the same claim, proof and
// badge code as Brazil, with fake adapters. Nothing here knows CPF or CNPJ. Synthetic accounts only.
const COMPANY = "@empresa:bipe.test";
const PERSON = "@pessoa:bipe.test";
const OTHER = "@outra:bipe.test";
const MSK = "cmVzZWxsZXItbWFzdGVyLWtleS0wMS1mb3ItdGVzdHM";

// The fake registry: one active company, one closed company. The month is the copy the scan reads.
const registry = new Map([
  ["ZZ-0001", { active: true, legalName: "Empresa de Teste Ltda.", tradeName: null, checkedMonth: "2026-11" }],
  ["ZZ-0002", { active: false, legalName: "Empresa Fechada Ltda.", tradeName: null, checkedMonth: "2026-11" }],
]);
const zzOrg = {
  scheme: "zz.test",
  parseOrgId: (raw) => (/^ZZ-\d{4}$/.test(raw.trim()) ? raw.trim() : null),
  sameOrg: (a, b) => a === b,
  challenge: (orgId, userId, code, date) => `zz ${orgId} ${userId} ${code} ${date}`,
  record: async (_db, orgId) => registry.get(orgId) ?? null,
  latestMonth: () => "2026-11",
  refresh: async (_client, _config, orgIds) => ({
    month: "2026-11",
    states: new Map(orgIds.map((id) => [id, !registry.has(id) ? "not_found" : registry.get(id).active ? "active" : "not_active"])),
  }),
  reservedNames: () => [],
  badge: async (_db, orgId) => {
    const r = registry.get(orgId);
    if (!r?.active) return null;
    return {
      name: r.legalName,
      cacheParts: [orgId, r.legalName],
      fields: (method) => ({ lvl: "org", country: "ZZ", scheme: "zz.test", assurance: "registry+control", org_id: orgId, name: r.legalName, legal_name: r.legalName, method }),
    };
  },
};
// The fake control proof: the signature is the challenge with a prefix.
const zzControl = {
  scheme: "zz.test",
  method: "staff",
  verify: async (signature, challenge) => {
    if (signature !== `signed:${challenge}`) throw Object.assign(new Error("bad"), { id: "signature_invalid" });
  },
};
const zzPerson = {
  scheme: "zz.test-person",
  level: "person",
  country: "ZZ",
  assurance: "state",
  dedupeHash: (secret, subject) => createHash("sha256").update(`${secret}:${subject}`).digest("hex"),
};
registerTestScheme(zzOrg);
registerTestScheme(zzPerson);

async function setup(t) {
  const db = await isolatedDatabase(t);
  const { rows: [{ schema }] } = await db.query("SELECT current_schema() AS schema");
  await db.query("CREATE TABLE e2e_cross_signing_keys (user_id text, keytype text, keydata text, stream_id bigint)");
  for (const user of [COMPANY, PERSON]) {
    await db.query("INSERT INTO e2e_cross_signing_keys VALUES ($1, 'master', $2, 1)", [
      user,
      JSON.stringify({ user_id: user, usage: ["master"], keys: { [`ed25519:${MSK}`]: MSK } }),
    ]);
  }
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

function payloadOf(envelope, publicKey) {
  const bytes = Buffer.from(envelope.payload, "base64url");
  assert.ok(verify(null, bytes, publicKey, Buffer.from(envelope.sig, "base64url")), "the signature verifies");
  return JSON.parse(bytes);
}

async function inTransaction(db, work) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await work(client);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

test("only a zz scheme can be registered for a test", () => {
  assert.throws(() => registerTestScheme({ ...zzOrg, scheme: "br.cnpj" }), /not a zz test scheme/);
  assert.throws(() => registerTestScheme({ ...zzPerson, scheme: "nl.itsme" }), /not a zz test scheme/);
});

test("a zz company claims, proves control and gets an org badge", async (t) => {
  const { db, badges, publicKey } = await setup(t);
  assert.equal((await createClaim(db, {}, COMPANY, "not an id", () => {}, zzOrg).catch((e) => e)).id, "cnpj_invalid");
  const claim = await createClaim(db, {}, COMPANY, "ZZ-0001", () => {}, zzOrg);
  assert.equal(claim.status, "awaiting_proof");
  assert.equal(claim.cnpj, "ZZ-0001", "the Brazilian route shape names the org ID cnpj");
  const { rows: [row] } = await db.query("SELECT scheme, org_id, challenge FROM business_claims WHERE user_id = $1", [COMPANY]);
  assert.deepEqual({ scheme: row.scheme, org_id: row.org_id }, { scheme: "zz.test", org_id: "ZZ-0001" });

  await assert.rejects(proveControl(db, COMPANY, "wrong", zzControl));
  const proved = await proveControl(db, COMPANY, `signed:${row.challenge}`, zzControl);
  assert.equal(proved.status, "verified");

  const result = await badges.forUser(COMPANY);
  assert.equal(result.status, 200);
  const payload = payloadOf(result.envelope, publicKey);
  assert.deepEqual(
    { lvl: payload.lvl, country: payload.country, scheme: payload.scheme, assurance: payload.assurance, org_id: payload.org_id, msk: payload.msk },
    { lvl: "org", country: "ZZ", scheme: "zz.test", assurance: "registry+control", org_id: "ZZ-0001", msk: MSK },
  );
  assert.equal(payload.cnpj, undefined, "no Brazilian field");
});

test("the scan revokes a zz company that the registry no longer shows as active", async (t) => {
  const { db, badges } = await setup(t);
  const claim = await createClaim(db, {}, COMPANY, "ZZ-0001", () => {}, zzOrg);
  assert.equal(claim.status, "awaiting_proof");
  await proveControl(db, COMPANY, `signed:${(await db.query("SELECT challenge FROM business_claims WHERE user_id = $1", [COMPANY])).rows[0].challenge}`, zzControl);
  registry.set("ZZ-0001", { ...registry.get("ZZ-0001"), active: false });
  t.after(() => registry.set("ZZ-0001", { ...registry.get("ZZ-0001"), active: true }));
  await runScan(db, {}, "all", () => {});
  const { rows: [row] } = await db.query("SELECT status, reason FROM business_claims WHERE user_id = $1", [COMPANY]);
  assert.deepEqual({ ...row }, { status: "revoked", reason: "not_active" });
  assert.equal((await badges.forUser(COMPANY)).status, 410);
});

test("a zz person proof gives a person badge, and one subject stays on one account", async (t) => {
  const { db, badges, publicKey } = await setup(t);
  const input = { proof: zzPerson, secret: "zz-test-secret", subject: "ZZ-PERSON-1", userId: PERSON, verifiedName: "Pessoa de Teste", masterKey: MSK, now: new Date() };
  await inTransaction(db, (client) => recordPersonProof(client, input));
  const envelopes = await badges.proofsFor(PERSON);
  assert.equal(envelopes.length, 1);
  const payload = payloadOf(envelopes[0], publicKey);
  assert.deepEqual(
    { lvl: payload.lvl, country: payload.country, scheme: payload.scheme, assurance: payload.assurance, name: payload.name, msk: payload.msk },
    { lvl: "person", country: "ZZ", scheme: "zz.test-person", assurance: "state", name: "Pessoa de Teste", msk: MSK },
  );
  const { rows: [identity] } = await db.query("SELECT scheme, dedupe_hash FROM person_identities WHERE user_id = $1", [PERSON]);
  assert.equal(identity.scheme, "zz.test-person");
  assert.notEqual(identity.dedupe_hash, "ZZ-PERSON-1", "only the keyed hash is stored");

  await assert.rejects(
    inTransaction(db, (client) => recordPersonProof(client, { ...input, userId: OTHER })),
    (e) => e.code === "23505",
    "the same subject on another account fails on the unique index",
  );
});
