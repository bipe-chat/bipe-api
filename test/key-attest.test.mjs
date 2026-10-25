import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { createKeyAttestationVerifier, verifyKeyAttestation } from "../dist/key-attest.js";
import { signup } from "../dist/signup.js";
import { BOOT_KEY, keyAttestation, otherRoot, PACKAGE, SIGNING_DIGEST, syntheticRoot } from "./helpers/key-attestation.mjs";

const refused = (error) => error.id === "attestation_invalid";
const policy = { packages: [PACKAGE], certDigests: [], bootKeys: [] };
const verifier = (revoked = new Set()) => createKeyAttestationVerifier([syntheticRoot], () => revoked);
const verify = verifier();

test("a locked phone with verified boot and a hardware keystore is attested", async () => {
  const { proof } = await keyAttestation();
  assert.deepEqual(verify(proof, policy), { attested: true });
});

test("StrongBox counts like the TEE", async () => {
  const { proof } = await keyAttestation({ security: 2 });
  assert.deepEqual(verify(proof, policy), { attested: true });
});

test("a genuine chain from a phone that is not attested goes on as no attestation (ADR 0043)", async () => {
  const cases = [
    [{ security: 0 }, "software"],
    [{ locked: false }, "unlocked"],
    [{ bootState: 2 }, "boot-state"],
    [{ bootState: 3 }, "boot-state"],
    [{ bootState: 1, bootKey: BOOT_KEY }, "boot-state"],
    [{ rootOfTrust: false }, "root-of-trust"],
  ];
  for (const [options, reason] of cases) {
    const { proof } = await keyAttestation(options);
    assert.deepEqual(verify(proof, policy), { attested: false, reason }, JSON.stringify(options));
  }
});

test("a custom OS counts only with a configured verified boot key", async () => {
  const { proof } = await keyAttestation({ bootState: 1, bootKey: BOOT_KEY });
  assert.deepEqual(verify(proof, { ...policy, bootKeys: [BOOT_KEY] }), { attested: true });
});

test("a chain that does not end at a pinned root is refused", async () => {
  const { proof } = await keyAttestation({ trustRoot: otherRoot });
  assert.throws(() => verify(proof, policy), refused);
});

test("the production verifier keeps Google's pinned roots", async () => {
  const { proof } = await keyAttestation();
  assert.throws(() => verifyKeyAttestation(proof, policy), refused);
});

test("a broken chain is refused", async () => {
  const { proof } = await keyAttestation({ breakChain: true });
  assert.throws(() => verify(proof, policy), refused);
  const swapped = await keyAttestation();
  const [leaf, inter, root] = swapped.proof.key_attestation_chain;
  assert.throws(() => verify({ ...swapped.proof, key_attestation_chain: [inter, leaf, root] }, policy), refused);
});

test("garbage certificates are refused", async () => {
  const { proof } = await keyAttestation();
  assert.throws(() => verify({ ...proof, key_attestation_chain: ["AAAA", "AAAA"] }, policy), refused);
});

test("the key must be bound to this challenge", async () => {
  const { proof } = await keyAttestation({ boundChallenge: "another-synthetic-challenge" });
  assert.throws(() => verify(proof, policy), refused);
});

test("unknown and reused challenges are refused", async () => {
  const unknown = await keyAttestation({ challenge: "synthetic-unknown-challenge" });
  assert.throws(() => verify(unknown.proof, policy), refused);
  const { proof } = await keyAttestation();
  verify(proof, policy);
  assert.throws(() => verify(proof, policy), refused);
});

test("another app is refused", async () => {
  const { proof } = await keyAttestation({ packageName: "com.example.other" });
  assert.throws(() => verify(proof, policy), refused);
});

test("configured signing digests must match", async () => {
  const other = await keyAttestation({ digest: "00".repeat(32) });
  assert.throws(() => verify(other.proof, { ...policy, certDigests: [SIGNING_DIGEST] }), refused);
  const { proof } = await keyAttestation();
  assert.deepEqual(verify(proof, { ...policy, certDigests: [SIGNING_DIGEST] }), { attested: true });
});

test("a revoked certificate in the chain is refused", async () => {
  const { proof, serials } = await keyAttestation();
  assert.throws(() => verifier(new Set([serials.intermediate]))(proof, policy), refused);
});

test("without Google's status list a genuine chain passes but is not attested", async () => {
  const { proof } = await keyAttestation();
  const noList = createKeyAttestationVerifier([syntheticRoot], () => null);
  assert.deepEqual(noList(proof, policy), { attested: false, reason: "status-unavailable" });
});

const config = {
  APP_ATTEST_APP_IDS: ["TESTTEAM01.chat.bipe.app.dev"], APP_ATTEST_ENVIRONMENT: "production",
  SIGNUP_ATTEST_REQUIRED: false, SIGNUP_TERMS_REQUIRED: false, SIGNUP_INVITE_REQUIRED: true,
  ANDROID_ATTEST_PACKAGES: [PACKAGE], ANDROID_ATTEST_CERT_DIGESTS: [], ANDROID_ATTEST_BOOT_KEYS: [],
};

test("sign-up: an unattested Android phone gets the same answer as a phone that sends nothing", async () => {
  // Every path stops before database or MAS access. Reaching invite validation means the attestation step passed.
  const deps = { config, verifyKeyAttestation: verify };
  const rooted = async () => ({ attestation: (await keyAttestation({ locked: false, bootState: 2 })).proof });
  await assert.rejects(signup(deps, await rooted()), (error) => error.id === "invite_invalid");
  await assert.rejects(signup({ ...deps, config: { ...config, SIGNUP_ATTEST_REQUIRED: true } }, await rooted()), refused);
  await assert.rejects(signup(deps, { ...(await rooted()), account_type: "company" }), refused);
});

test("sign-up: an attested Android phone passes a required attestation, a forged chain never does", async () => {
  const deps = { config: { ...config, SIGNUP_ATTEST_REQUIRED: true }, verifyKeyAttestation: verify };
  await assert.rejects(signup(deps, { attestation: (await keyAttestation()).proof }), (error) => error.id === "invite_invalid");
  await assert.rejects(signup(deps, { attestation: (await keyAttestation({ trustRoot: otherRoot })).proof }), refused);
  // Without an injected verifier, sign-up uses Google's roots.
  await assert.rejects(signup({ config }, { attestation: (await keyAttestation()).proof }), refused);
});

const env = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://unused.invalid/test",
  SERVER_NAME: "example.test",
  SYNAPSE_URL: "https://matrix.example.test",
  MAS_URL: "https://mas.example.test",
  MAS_ADMIN_URL: "https://mas.example.test",
  MAS_CLIENT_ID: "synthetic-client",
  MAS_CLIENT_SECRET: "synthetic-client-secret",
  BIPE_INTERNAL_SECRET: "synthetic-only-internal-secret-32-bytes",
  APP_ATTEST_ENVIRONMENT: "production",
  APP_ATTEST_APP_IDS: "TESTTEAM01.chat.bipe.app.dev",
};

test("config: Android packages default to the store and Bipe Next IDs, also when Compose passes an empty value", () => {
  const expected = ["chat.bipe.app", "chat.bipe.app.next", "chat.bipe.app.next.debug"];
  assert.deepEqual(loadConfig(env).ANDROID_ATTEST_PACKAGES, expected);
  assert.deepEqual(loadConfig({ ...env, ANDROID_ATTEST_PACKAGES: "" }).ANDROID_ATTEST_PACKAGES, expected);
  assert.deepEqual(loadConfig({ ...env, ANDROID_ATTEST_PACKAGES: " chat.bipe.app " }).ANDROID_ATTEST_PACKAGES, ["chat.bipe.app"]);
  assert.throws(() => loadConfig({ ...env, ANDROID_ATTEST_PACKAGES: "not a package" }), /ANDROID_ATTEST_PACKAGES/);
});

test("config: digests and boot keys are optional lower-case SHA-256 lists", () => {
  const config = loadConfig({ ...env, ANDROID_ATTEST_CERT_DIGESTS: "", ANDROID_ATTEST_BOOT_KEYS: BOOT_KEY.toUpperCase() });
  assert.deepEqual(config.ANDROID_ATTEST_CERT_DIGESTS, []);
  assert.deepEqual(config.ANDROID_ATTEST_BOOT_KEYS, [BOOT_KEY]);
  assert.throws(() => loadConfig({ ...env, ANDROID_ATTEST_CERT_DIGESTS: "abc" }), /ANDROID_ATTEST_CERT_DIGESTS/);
});
