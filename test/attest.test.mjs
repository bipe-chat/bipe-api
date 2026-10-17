import assert from "node:assert/strict";
import { test } from "node:test";
import { createAttestationVerifier, newChallenge, verifyAttestation } from "../dist/attest.js";
import { signup } from "../dist/signup.js";
import { attestation, APP_ID, syntheticRoot } from "./helpers/attestation.mjs";

const verifySynthetic = createAttestationVerifier(syntheticRoot);
const refused = (error) => error.id === "attestation_invalid";

test("valid signed production evidence works for an explicitly allowed development bundle", async () => {
  verifySynthetic(await attestation(), [APP_ID], "production");
});

test("signed development evidence is refused by production policy", async () => {
  const proof = await attestation({ environment: "development" });
  assert.throws(() => verifySynthetic(proof, [APP_ID], "production"), refused);
});

test("explicit development policy accepts development evidence and refuses production evidence", async () => {
  verifySynthetic(await attestation({ environment: "development" }), [APP_ID], "development");
  const proof = await attestation();
  assert.throws(() => verifySynthetic(proof, [APP_ID], "development"), refused);
});

test("a missing verifier environment cannot fall back to development evidence", async () => {
  const proof = await attestation({ environment: "development" });
  assert.throws(() => verifySynthetic(proof, [APP_ID], undefined), refused);
});

test("valid chain and signature do not bypass the team and bundle allowlist", async () => {
  for (const appId of ["OTHERTEAM1.chat.bipe.app.dev", "TESTTEAM01.chat.other.app"]) {
    const proof = await attestation({ appId });
    assert.throws(() => verifySynthetic(proof, [APP_ID], "production"), refused);
  }
});

test("the production verifier keeps Apple's pinned root", async () => {
  const proof = await attestation();
  assert.throws(() => verifyAttestation(proof, [APP_ID], "production"), refused);
});

test("a successful challenge can only be consumed once", async () => {
  const proof = await attestation();
  verifySynthetic(proof, [APP_ID], "production");
  assert.throws(() => verifySynthetic(proof, [APP_ID], "production"), refused);
});

test("wrong-environment rejection still consumes the challenge", async () => {
  const proof = await attestation({ environment: "development" });
  assert.throws(() => verifySynthetic(proof, [APP_ID], "production"), refused);
  assert.throws(() => verifySynthetic(proof, [APP_ID], "development"), refused);
});

test("unknown and expired challenges are refused", async (t) => {
  const unknown = await attestation({ challenge: "synthetic-unknown-challenge" });
  assert.throws(() => verifySynthetic(unknown, [APP_ID], "production"), refused);
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now });
  const proof = await attestation();
  t.mock.timers.setTime(now + 5 * 60_000);
  assert.throws(() => verifySynthetic(proof, [APP_ID], "production"), refused);
});

test("a signed certificate for another challenge fails nonce binding", async () => {
  const proof = await attestation({ nonceChallenge: "another-synthetic-challenge" });
  assert.throws(() => verifySynthetic(proof, [APP_ID], "production"), refused);
});

test("optional signup still verifies a supplied proof and required signup refuses its absence", async () => {
  const config = { APP_ATTEST_APP_IDS: [APP_ID], APP_ATTEST_ENVIRONMENT: "production", SIGNUP_ATTEST_REQUIRED: false, SIGNUP_TERMS_REQUIRED: false, SIGNUP_INVITE_REQUIRED: true };
  // Both paths stop before database/MAS access. Optional absence reaches invite validation.
  await assert.rejects(signup({ config }, {}), (error) => error.id === "invite_invalid");
  await assert.rejects(signup({ config }, { attestation: { key_id: "x", challenge: newChallenge(), attestation_object: "x" } }), refused);
  await assert.rejects(signup({ config: { ...config, SIGNUP_ATTEST_REQUIRED: true } }, {}), refused);
  await assert.rejects(signup({ config }, { account_type: "company" }), refused);
});
