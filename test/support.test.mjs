import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import * as sdk from "@matrix-org/matrix-sdk-crypto-nodejs";
import { signatureUploadBody } from "../dist/support.js";

// The support bot's cross-signing requests (ADR 0114) against a real OlmMachine. No homeserver.

// matrix-sdk-crypto-nodejs 0.6.6 aborts in its Tokio teardown when Node exits normally. The API never
// exits that way; the test file leaves without the teardown once its tests have reported.
after(() => setImmediate(() => process.reallyExit(process.exitCode ?? 0)));

async function machine(t) {
  const dir = mkdtempSync(join(tmpdir(), "bipe-support-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const m = await sdk.OlmMachine.initialize(new sdk.UserId("@suporte:example.test"), new sdk.DeviceId("SUPPORTBOT"), dir, "test-only-passphrase");
  for (const req of await m.outgoingRequests()) {
    const res = req.type === sdk.RequestType.KeysUpload ? { one_time_key_counts: {} } : { device_keys: {}, failures: {} };
    await m.markRequestAsSent(req.id, req.type, JSON.stringify(res));
  }
  return m;
}

test("the signature upload body is the user map, not the SDK's signed_keys wrapper", async (t) => {
  const m = await machine(t);
  const boot = await m.bootstrapCrossSigning(true);
  assert.deepEqual(Object.keys(JSON.parse(boot.uploadSignaturesReq.body)), ["signed_keys"]);
  const body = JSON.parse(signatureUploadBody(boot.uploadSignaturesReq.body));
  assert.deepEqual(Object.keys(body), ["@suporte:example.test"]);
  assert.ok(body["@suporte:example.test"].SUPPORTBOT, "the device is in the body");
  // The SDK parses the answer Synapse gives to the right body.
  assert.equal(await m.markRequestAsSent(boot.uploadSignaturesReq.id, sdk.RequestType.SignatureUpload, '{"failures":{}}'), true);
});

test("a body without the wrapper goes out unchanged", () => {
  const body = JSON.stringify({ "@suporte:example.test": { SUPPORTBOT: {} } });
  assert.equal(signatureUploadBody(body), body);
});

test("bootstrap without reset keeps the keys and signs the device with the self-signing key", async (t) => {
  const m = await machine(t);
  const first = await m.bootstrapCrossSigning(true);
  const again = await m.bootstrapCrossSigning(false);
  const keys = (req, name) => JSON.parse(req.uploadSigningKeysReq)[name].keys;
  assert.deepEqual(keys(again, "master_key"), keys(first, "master_key"));
  const ssk = Object.keys(keys(again, "self_signing_key"))[0];
  const device = JSON.parse(signatureUploadBody(again.uploadSignaturesReq.body))["@suporte:example.test"].SUPPORTBOT;
  assert.ok(device.signatures["@suporte:example.test"][ssk], "the self-signing key signed the device");
});
