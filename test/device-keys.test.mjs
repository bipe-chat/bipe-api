import assert from "node:assert/strict";
import { test } from "node:test";
import { deviceSignatureValid, parseDeviceKey, passwordOnceMessage } from "../dist/device-keys.js";

// bipe-shared test-vectors/device-keys.json, vector "valid" (TEST-ONLY key). The apps sign these same bytes.
const VECTOR = {
  "public_key": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEdDGxjwVayHOx63102HFq0ePfBpCLAMwvkBFT+OtkKBhIZ8D9qzOcbEkKOa5wTSm1tMLxJENQopBZYiz0m0IRVQ==",
  "user_id": "@fmtestuser01:bipe.net.br",
  "device_id": "ABCDEFGHIJ",
  "challenge": "dGVzdC1vbmx5LWNoYWxsZW5nZS0wMDAwMDAwMDAwMDA",
  "signature": "MEUCIHnBhn9SYUizxepWMa3k2ljZo+4aq6+uUllRcsY7LLuNAiEA3XK2dv391yElWHxdNUdxusrdYbB4UdwuETBVwwtzoig=",
  "message_utf8": "bipe-password-once:v1\n@fmtestuser01:bipe.net.br\nABCDEFGHIJ\ndGVzdC1vbmx5LWNoYWxsZW5nZS0wMDAwMDAwMDAwMDA"
};

test("the signed message and the signature match the bipe-shared vector", () => {
  const message = passwordOnceMessage(VECTOR.user_id, VECTOR.device_id, VECTOR.challenge);
  assert.equal(message.toString("utf8"), VECTOR.message_utf8);
  const key = parseDeviceKey(VECTOR.public_key);
  assert.equal(deviceSignatureValid(key, message, VECTOR.signature), true);
  assert.equal(deviceSignatureValid(key, passwordOnceMessage(VECTOR.user_id, "OTHER", VECTOR.challenge), VECTOR.signature), false);
  assert.equal(deviceSignatureValid(key, message, "not-base64-der"), false);
});

test("only a P-256 key in SubjectPublicKeyInfo DER is a device key", () => {
  assert.throws(() => parseDeviceKey("AAAA"), (e) => e.id === "bad_request");
});
