import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Badges } from "../dist/badges.js";
import { BrandMarks, brandMarkCode } from "../dist/brand-marks.js";
import { exportData } from "../dist/export.js";
import { isolatedDatabase, testDatabaseUrl } from "./helpers/database.mjs";

// Brand marks for resellers (ADR 0162, bipe#483). Synthetic accounts only.
const BRAND = "@doces:example.test";
const SHOP = "@bia.revende:example.test";
const PERSON = "@ana:example.test";
const OTHER_BRANDS = ["@marca2:example.test", "@marca3:example.test", "@marca4:example.test"];
const MSK = "cmVzZWxsZXItbWFzdGVyLWtleS0wMS1mb3ItdGVzdHM"; // 43 characters, as Synapse stores an Ed25519 key

function failsWith(code) {
  return (error) => { assert.equal(`${error.id}:${error.reason ?? ""}`, code); return true; };
}

async function setup(t) {
  const db = await isolatedDatabase(t);
  const accounts = [[BRAND, "company"], [SHOP, "company"], [PERSON, "personal"], ...OTHER_BRANDS.map((b) => [b, "company"])];
  for (const [id, type] of accounts) await db.query("INSERT INTO signups (user_id, account_type) VALUES ($1, $2)", [id, type]);
  const brands = [[BRAND, "11222333000181", "Doces da Ana"], ...OTHER_BRANDS.map((b, i) => [b, `2233344400010${i}`, `Marca ${i + 2}`])];
  for (const [id, cnpj, name] of brands) {
    await db.query("INSERT INTO cnpj_registry (cnpj, active, legal_name, trade_name, release_month) VALUES ($1, true, $2, $3, '2026-09')", [cnpj, `${name} Ltda`, name]);
    await db.query("INSERT INTO business_claims (user_id, cnpj, status, challenge, method, verified_at) VALUES ($1, $2, 'verified', 'x', 'ecnpj', now())", [id, cnpj]);
  }
  // The Synapse table the badge code reads, in the same isolated schema.
  const { rows: [{ schema }] } = await db.query("SELECT current_schema() AS schema");
  await db.query("CREATE TABLE e2e_cross_signing_keys (user_id text, keytype text, keydata text, stream_id bigint)");
  await db.query("INSERT INTO e2e_cross_signing_keys VALUES ($1, 'master', $2, 1)", [
    SHOP,
    JSON.stringify({ user_id: SHOP, usage: ["master"], keys: { [`ed25519:${MSK}`]: MSK } }),
  ]);
  const keyDir = mkdtempSync(join(tmpdir(), "bipe-badge-"));
  t.after(() => rmSync(keyDir, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(join(keyDir, "key.pem"), privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(join(keyDir, "kid"), "prod-2026-10");
  const url = testDatabaseUrl(process.env.BIPE_TEST_DATABASE_URL);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const badges = new Badges(db, { keyDir, synapseUrl: url.href });
  t.after(() => badges.close());
  const marks = new BrandMarks(db, (id) => badges.verifiedBrand(id), "https://bipe.example/");
  return { db, badges, marks, publicKey };
}

test("brand mark codes come out of a bare code, a link or a pasted message", () => {
  const code = "AbCdEfGh12345678";
  assert.equal(brandMarkCode(code), code);
  assert.equal(brandMarkCode(`https://bipe.chat/marca/#${code}`), code);
  assert.equal(brandMarkCode(`Oi! Aceita a marca: https://bipe.chat/marca/#${code}.`), code);
  assert.equal(brandMarkCode("short"), null);
  assert.equal(brandMarkCode(`${code}x`), null);
});

test("a verified brand grants, the reseller accepts, customers read it signed, either side ends it", { timeout: 30000 }, async (t) => {
  const { db, badges, marks, publicKey } = await setup(t);

  // Only a verified company account grants, and only a label from the registry.
  await assert.rejects(marks.createInvite(PERSON, "revendedora"), failsWith("brand_not_verified:"));
  await assert.rejects(marks.createInvite(SHOP, "revendedora"), failsWith("brand_not_verified:"));
  await assert.rejects(marks.createInvite(BRAND, "embaixadora"), failsWith("bad_request:label"));

  const created = await marks.createInvite(BRAND, "revendedora");
  assert.match(created.code, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(created.link, `https://bipe.example/marca/#${created.code}`);
  const { rows: stored } = await db.query("SELECT code_hash FROM brand_mark_invites");
  assert.notEqual(stored[0].code_hash, created.code, "only the hash is stored");

  const preview = await marks.preview(created.link);
  assert.deepEqual({ ...preview, expires_at: undefined }, { brand: BRAND, brand_name: "Doces da Ana", cnpj: "11222333000181", label: "revendedora", expires_at: undefined });
  assert.equal((await marks.granted(BRAND)).invites.length, 1);

  // A personal account and the brand itself cannot accept; the invite stays open.
  await assert.rejects(marks.accept(PERSON, created.code), failsWith("bad_request:not_work_account"));
  await assert.rejects(marks.accept(BRAND, created.code), failsWith("bad_request:own_brand"));

  assert.deepEqual(await badges.brandMarks(SHOP), []);
  const held = await marks.accept(SHOP, created.code);
  assert.equal(held.brand_name, "Doces da Ana");
  await assert.rejects(marks.preview(created.code), failsWith("not_found:"), "single use");
  await assert.rejects(marks.accept(SHOP, created.code), failsWith("not_found:"));

  // Customers read the mark signed with the badge key, bound to the reseller's master key.
  const envelopes = await badges.brandMarks(SHOP);
  assert.equal(envelopes.length, 1);
  const bytes = Buffer.from(envelopes[0].payload, "base64url");
  assert.ok(verify(null, bytes, publicKey, Buffer.from(envelopes[0].sig, "base64url")));
  const payload = JSON.parse(bytes.toString("utf8"));
  assert.deepEqual(
    { sub: payload.sub, lvl: payload.lvl, name: payload.name, mark: payload.mark, brand: payload.brand, cnpj: payload.cnpj, label: payload.label, msk: payload.msk },
    { sub: SHOP, lvl: "brand-mark", name: "Doces da Ana", mark: held.id, brand: BRAND, cnpj: "11222333000181", label: "revendedora", msk: MSK },
  );
  assert.equal(payload.exp - payload.iat, 7 * 86400);
  assert.deepEqual((await marks.held(SHOP)).marks.map((m) => m.id), [held.id]);
  assert.deepEqual((await marks.granted(BRAND)).marks.map((m) => m.reseller), [SHOP]);

  // A second invite of the same brand is refused while the mark is active.
  const again = await marks.createInvite(BRAND, "revendedor");
  await assert.rejects(marks.accept(SHOP, again.code), failsWith("bad_request:already_held"));

  // A brand that loses its seal: the mark is left out at once.
  await db.query("UPDATE business_claims SET status = 'revoked' WHERE user_id = $1", [BRAND]);
  assert.deepEqual(await badges.brandMarks(SHOP), []);
  await assert.rejects(marks.preview(again.code), failsWith("not_found:"));
  await db.query("UPDATE business_claims SET status = 'verified' WHERE user_id = $1", [BRAND]);
  assert.equal((await badges.brandMarks(SHOP)).length, 1);

  // Nobody else can end it; the brand can, at once.
  await assert.rejects(marks.end(PERSON, held.id), failsWith("not_found:"));
  await assert.rejects(marks.end(SHOP, "not-a-uuid"), failsWith("not_found:"));
  await marks.end(BRAND, held.id);
  assert.deepEqual(await badges.brandMarks(SHOP), []);
  await assert.rejects(marks.end(SHOP, held.id), failsWith("not_found:"));

  // The audit log keeps who did what, by account ID.
  const { rows: events } = await db.query("SELECT action, actor_user_id FROM brand_mark_events ORDER BY id");
  assert.deepEqual(events.map((e) => `${e.action}:${e.actor_user_id}`), [
    `invite_created:${BRAND}`, `accepted:${SHOP}`, `invite_created:${BRAND}`, `ended:${BRAND}`,
  ]);

  const exported = await exportData(db, { rowsOf: async () => [] }, SHOP);
  assert.equal(exported.brand_marks.length, 1);
  assert.equal(exported.brand_mark_events.length, 1);
});

test("refuse uses the invite; a reseller holds at most 3 marks; the brand cancels an open invite", { timeout: 30000 }, async (t) => {
  const { marks } = await setup(t);
  const refused = await marks.createInvite(BRAND, "corretor");
  await marks.refuse(SHOP, refused.code);
  await assert.rejects(marks.accept(SHOP, refused.code), failsWith("not_found:"));
  assert.deepEqual(await marks.held(SHOP), { marks: [] });

  for (const brand of [BRAND, ...OTHER_BRANDS.slice(0, 2)]) {
    const invite = await marks.createInvite(brand, "representante");
    await marks.accept(SHOP, invite.code);
  }
  const fourth = await marks.createInvite(OTHER_BRANDS[2], "revendedora");
  await assert.rejects(marks.accept(SHOP, fourth.code), failsWith("brand_mark_limit:"));
  // The invite stays open: after the reseller ends one mark, it works.
  const first = (await marks.held(SHOP)).marks[0];
  await marks.end(SHOP, first.id);
  await marks.accept(SHOP, fourth.code);
  assert.equal((await marks.held(SHOP)).marks.length, 3);

  const open = await marks.createInvite(BRAND, "revendedora");
  await assert.rejects(marks.cancelInvite(SHOP, open.invite.id), failsWith("not_found:"));
  await marks.cancelInvite(BRAND, open.invite.id);
  await assert.rejects(marks.preview(open.code), failsWith("not_found:"));
  assert.equal((await marks.granted(BRAND)).invites.length, 0);
});

test("an expired invite is not found; prune keeps active marks and drops old ended ones", { timeout: 30000 }, async (t) => {
  const { db, marks } = await setup(t);
  const past = new Date(Date.now() - 400 * 86_400_000);
  const old = await marks.createInvite(BRAND, "revendedora", past);
  await assert.rejects(marks.preview(old.code), failsWith("not_found:"));

  const active = await marks.createInvite(BRAND, "revendedora");
  const held = await marks.accept(SHOP, active.code);
  const ended = await marks.createInvite(OTHER_BRANDS[0], "revendedora");
  const gone = await marks.accept(SHOP, ended.code);
  await marks.end(SHOP, gone.id, past);
  await db.query("UPDATE brand_mark_events SET at = $1 WHERE mark_id = $2", [past, gone.id]);

  assert.ok((await marks.prune()) > 0);
  const { rows } = await db.query("SELECT id FROM brand_marks ORDER BY id");
  assert.deepEqual(rows.map((r) => r.id), [held.id]);
  const { rows: invites } = await db.query("SELECT id FROM brand_mark_invites");
  assert.deepEqual(invites.map((r) => r.id), [active.invite.id]);
});
