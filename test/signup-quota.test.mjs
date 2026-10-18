import assert from "node:assert/strict";
import { test } from "node:test";
import { newChallenge } from "../dist/attest.js";
import { RateLimiter } from "../dist/ratelimit.js";
import { signup } from "../dist/signup.js";
import { SignupLimits } from "../dist/signup-limits.js";
import { APP_ID } from "./helpers/attestation.mjs";

// bipe#395. No database and no MAS: every rejected path here stops before both.
const config = { APP_ATTEST_APP_IDS: [APP_ID], APP_ATTEST_ENVIRONMENT: "production", SIGNUP_ATTEST_REQUIRED: false, SIGNUP_TERMS_REQUIRED: false, SIGNUP_INVITE_REQUIRED: true };
const noBackend = { config, db: { query: () => { throw new Error("database touched"); }, connect: () => { throw new Error("database touched"); } } };
const forged = () => ({ attestation: { key_id: "x", challenge: newChallenge(), attestation_object: "x" } });
const failsWith = (id) => (error) => { assert.equal(error.id, id); return true; };

test("a take gives back once, and a refused take uses nothing", () => {
  const limiter = new RateLimiter(2, 60_000);
  const first = limiter.take("all");
  limiter.take("all");
  for (let i = 0; i < 5; i++) assert.throws(() => limiter.take("all"), failsWith("rate_limited"));
  first();
  first();
  limiter.take("all");
  assert.throws(() => limiter.take("all"), failsWith("rate_limited"));
});

test("a give-back from an ended window does not open the new window", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const limiter = new RateLimiter(1, 60_000);
  const old = limiter.take("all");
  t.mock.timers.setTime(1_000_000 + 61_000);
  limiter.take("all");
  old();
  assert.throws(() => limiter.take("all"), failsWith("rate_limited"));
});

test("forged attestations from one IP use no account creations", async () => {
  const limits = new SignupLimits(30);
  for (let i = 0; i < 30; i++) {
    limits.attempt("203.0.113.9", true);
    await assert.rejects(signup(noBackend, forged(), limits.creation), failsWith("attestation_invalid"));
  }
  // The attacking IP is out of attempts. Another IP still has the whole hour of creations.
  assert.throws(() => limits.attempt("203.0.113.9", true), failsWith("rate_limited"));
  limits.attempt("198.51.100.7", false);
  for (let i = 0; i < 30; i++) limits.creation();
  assert.throws(() => limits.creation(), failsWith("rate_limited"));
});

test("a missing invite and a required attestation use no account creation", async () => {
  const limits = new SignupLimits(1);
  await assert.rejects(signup(noBackend, {}, limits.creation), failsWith("invite_invalid"));
  await assert.rejects(signup({ ...noBackend, config: { ...config, SIGNUP_ATTEST_REQUIRED: true } }, {}, limits.creation), failsWith("attestation_invalid"));
  await assert.rejects(signup(noBackend, { account_type: "company" }, limits.creation), failsWith("attestation_invalid"));
  limits.creation();
});

test("attempts without an attestation keep the small per-IP limit", () => {
  const limits = new SignupLimits(30);
  for (let i = 0; i < 5; i++) limits.attempt("192.0.2.1", false);
  assert.throws(() => limits.attempt("192.0.2.1", false), failsWith("rate_limited"));
});

test("simultaneous creations cannot pass the ceiling", async () => {
  const limits = new SignupLimits(3);
  const results = await Promise.allSettled(Array.from({ length: 10 }, async () => limits.creation()));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  results.find((r) => r.status === "fulfilled").value();
  limits.creation();
  assert.throws(() => limits.creation(), failsWith("rate_limited"));
});
