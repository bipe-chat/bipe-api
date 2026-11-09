import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { listVersion, loadStoredLists, newestList, publishList } from "../dist/signed-lists.js";
import { listHash } from "../src/generated/lib/signed-lists.mjs";
import { isolatedDatabase } from "./helpers/database.mjs";

// POST /v1/{typ} (bipe-chat/bipe#1242): a newer signed version comes in with no deploy. TEST-ONLY key made here; the
// signer set of the image is replaced by a set with that key, so the real signer key is never needed.
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const testSigners = { threshold: 1, keys: { "test-only": publicKey.export({ format: "jwk" }).x } };
const otherKey = generateKeyPairSync("ed25519").privateKey;
const b64 = (bytes) => Buffer.from(bytes).toString("base64url");

/** The next version of the newest operator list in the image, signed with `key`. */
function next(change = {}, key = privateKey) {
  const current = JSON.parse(newestList("operators"));
  const bytes = Buffer.from(current.payload, "base64url");
  const payload = JSON.parse(bytes.toString("utf8"));
  const issued = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ ...payload, version: payload.version + 1, prev: listHash(bytes), issued, expires: issued + 14 * 86400, ...change }));
  return { version: payload.version + 1, text: JSON.stringify({ v: 1, payload: b64(body), sigs: [{ kid: "test-only", sig: b64(sign(null, body, key)) }] }) };
}

test("a newer signed version is stored, served and kept across a reload; the same envelope again is idempotent", async (t) => {
  const db = await isolatedDatabase(t);
  const now = Math.floor(Date.now() / 1000);
  const before = newestList("operators");
  assert.ok(before, "the image carries version 1");

  // Wrong envelopes change nothing.
  await assert.rejects(publishList(db, "operators", "not json", now, testSigners), { id: "bad_request", reason: "malformed" });
  await assert.rejects(publishList(db, "operators", next({}, otherKey).text, now, testSigners), { reason: "invalid_signature" });
  await assert.rejects(publishList(db, "issuers", next().text, now, testSigners), { reason: "wrong_type" });
  await assert.rejects(publishList(db, "operators", next({ prev: "A".repeat(43) }).text, now, testSigners), { reason: "broken_chain" });
  await assert.rejects(publishList(db, "operators", before, now, testSigners), { reason: "invalid_signature" }, "the image's signer is not in the test set");
  assert.equal(newestList("operators"), before);

  const good = next();
  assert.equal(await publishList(db, "operators", good.text, now, testSigners), good.version);
  assert.equal(newestList("operators"), good.text);
  assert.equal(listVersion("operators", String(good.version)), good.text);
  assert.equal(await publishList(db, "operators", good.text, now, testSigners), good.version, "the same envelope again");

  // Another version with the same number is a rollback, also when it is signed.
  await assert.rejects(publishList(db, "operators", next({ version: good.version }).text, now, testSigners), { reason: "rolled_back" });
  const { rows } = await db.query("SELECT typ, version, envelope FROM signed_lists");
  assert.deepEqual(rows, [{ typ: "operators", version: String(good.version), envelope: good.text }]);

  await loadStoredLists(db);
  assert.equal(newestList("operators"), good.text);
});
