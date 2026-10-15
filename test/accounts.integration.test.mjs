import assert from "node:assert/strict";
import { test } from "node:test";
import { cancelRecovery, claimRecovery, confirmRecoveryEmail, redeemToken, requestRecoveryEmail, verifyPin } from "../dist/accounts.js";
import { Mailer } from "../dist/mailer.js";
import { Mas } from "../dist/mas.js";
import { newSecret, PinHasher, secretHash } from "../dist/secrets.js";
import { isolatedDatabase, testDatabaseUrl } from "./helpers/database.mjs";
import { masStub } from "./helpers/mas.mjs";

// Synthetic fixtures only. Assertions never print credentials, PINs, mail or token values.
const GOOD_PIN = "49382615";
const WRONG_PIN = "58273916";
const NEW_PIN = "72948163";
const pins = new PinHasher("11".repeat(32));
const goodHash = await pins.hash(GOOD_PIN);
const DAY = 86400000;
let sequence = 0;

class CapturingMailer extends Mailer {
  messages = [];
  sendLater(_to, _subject, text, _what) { this.messages.push(text); }
}

async function fixture(t, email = false) {
  const db = await isolatedDatabase(t);
  const stub = await masStub(t);
  const user = `@case${++sequence}:example.test`;
  const address = `case${sequence}@example.test`;
  const token = newSecret();
  const config = { SERVER_NAME: "example.test", MAS_URL: stub.url, MAS_ADMIN_URL: stub.url, MAS_CLIENT_ID: "test-client", MAS_CLIENT_SECRET: "test-only-client-secret", PUBLIC_SITE_URL: "https://bipe.example.test", BIPE_SMTP_HOST: "unused.invalid", BIPE_SMTP_PORT: 587, BIPE_MAIL_FROM: "Bipe <test@example.test>" };
  const mailer = new CapturingMailer(config);
  const deps = { db, config, pins, mas: new Mas(config), mailer };
  await db.query("INSERT INTO account_secrets (user_id, device_first, pin_hash, token_hash) VALUES ($1, true, $2, $3)", [user, goodHash, secretHash(token)]);
  if (email) await db.query("INSERT INTO recovery_emails (user_id, email, verified_at, lang) VALUES ($1, $2, now(), 'en')", [user, address]);
  return { ...deps, deps, stub, user, address, token };
}

async function recoveryLink(f) {
  await requestRecoveryEmail(f.deps, f.address);
  const body = f.mailer.messages.findLast((message) => message.includes("/recuperar/#"));
  const token = /\/recuperar\/#([A-Za-z0-9_-]{43})/.exec(body ?? "")?.[1];
  assert.ok(token, "the fake mailer must capture a recovery link");
  return token;
}

async function secretRow(f) {
  return (await f.db.query("SELECT pin_wrong_tries, pin_blocked_at, pin_hash, token_hash FROM account_secrets WHERE user_id = $1", [f.user])).rows[0];
}

function failsWith(code) {
  return (error) => { assert.equal(error.id ?? `${error.name}:${error.code ?? "unknown"}`, code); return true; };
}

test("database guard refuses production names, remote hosts and connection overrides", () => {
  for (const raw of [undefined, "not a URL", "postgres://bipe_test:fake@remote.example.test/bipe_test", "postgres://bipe_test:fake@127.0.0.1/bipe", "postgres://postgres:fake@127.0.0.1/bipe_test", "postgres://bipe_test:fake@127.0.0.1/bipe_test?host=remote.example.test"]) assert.throws(() => testDatabaseUrl(raw), /refused/);
  assert.throws(() => testDatabaseUrl("postgres://bipe_test:fake@127.0.0.1/bipe_test", "production"), /refused/);
});

test("invalid recovery factors do not consume PIN tries; valid factors with wrong PINs do", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, true);
  await assert.rejects(redeemToken(f.deps, newSecret(), WRONG_PIN), failsWith("recovery_invalid"));
  await assert.rejects(confirmRecoveryEmail(f.deps, newSecret(), WRONG_PIN), failsWith("recovery_invalid"));
  assert.equal((await secretRow(f)).pin_wrong_tries, 0);
  await assert.rejects(redeemToken(f.deps, f.token, WRONG_PIN), failsWith("pin_wrong"));
  const link = await recoveryLink(f);
  await assert.rejects(confirmRecoveryEmail(f.deps, link, WRONG_PIN), failsWith("pin_wrong"));
  assert.equal((await secretRow(f)).pin_wrong_tries, 2);
});

test("concurrent wrong PINs across recovery paths stop at five in total", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, true);
  const link = await recoveryLink(f);
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => i % 2 ? redeemToken(f.deps, f.token, WRONG_PIN) : confirmRecoveryEmail(f.deps, link, WRONG_PIN)));
  assert.ok(results.every((result) => result.status === "rejected"));
  const codes = results.map((result) => result.reason.id ?? result.reason.code ?? result.reason.name);
  assert.equal(results.filter((result) => result.reason.id === "pin_wrong").length, 4, `Only error IDs: ${codes.join(", ")}`);
  assert.equal(results.filter((result) => result.reason.id === "pin_blocked").length, 8);
  const row = await secretRow(f);
  assert.equal(row.pin_wrong_tries, 5);
  assert.ok(row.pin_blocked_at);
  await assert.rejects(verifyPin(f.deps, f.user, GOOD_PIN), failsWith("pin_blocked"));
});

test("concurrent redemption of one recovery token succeeds once", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => redeemToken(f.deps, f.token, GOOD_PIN)));
  const winners = results.filter((result) => result.status === "fulfilled");
  assert.equal(winners.length, 1);
  assert.ok(results.filter((result) => result.status === "rejected").every((result) => result.reason.id === "recovery_invalid"));
  assert.equal(f.stub.passwordCalls, 1);
  assert.ok((await secretRow(f)).token_hash === secretHash(winners[0].value.recovery_token), "only the winning token is stored");
});

test("email recovery cannot be claimed before its delay and works at the boundary", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, true);
  const started = await confirmRecoveryEmail(f.deps, await recoveryLink(f), GOOD_PIN);
  const ready = Date.parse(started.ready_at);
  t.mock.timers.enable({ apis: ["Date"], now: ready - 1 });
  const waiting = await claimRecovery(f.deps, started.recovery_id, started.claim_secret);
  assert.equal(waiting.state, "waiting");
  assert.equal("password" in waiting, false);
  assert.equal(f.stub.passwordCalls, 0);
  t.mock.timers.setTime(ready);
  const claimed = await claimRecovery(f.deps, started.recovery_id, started.claim_secret);
  assert.equal(claimed.state, "completed");
  assert.ok(typeof claimed.password === "string", "the ready recovery issues credentials");
});

test("cancellation, expiry and another recovery’s claim secret cannot yield credentials", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, true);
  const first = await confirmRecoveryEmail(f.deps, await recoveryLink(f), GOOD_PIN);
  const second = await confirmRecoveryEmail(f.deps, await recoveryLink(f), GOOD_PIN);
  await assert.rejects(claimRecovery(f.deps, first.recovery_id, second.claim_secret), failsWith("recovery_invalid"));
  await cancelRecovery(f.deps, f.user, first.recovery_id);
  const ready = Date.parse(first.ready_at);
  t.mock.timers.enable({ apis: ["Date"], now: ready + 1 });
  const cancelled = await claimRecovery(f.deps, first.recovery_id, first.claim_secret);
  assert.equal(cancelled.state, "cancelled");
  assert.equal("password" in cancelled, false);
  t.mock.timers.setTime(Date.parse(second.ready_at) + 7 * DAY + 1);
  const expired = await claimRecovery(f.deps, second.recovery_id, second.claim_secret);
  assert.equal(expired.state, "expired");
  assert.equal("password" in expired, false);
  assert.equal(f.stub.passwordCalls, 0);
});

test("an expired email link fails before spending a PIN try", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, true);
  const link = await recoveryLink(f);
  await f.db.query("UPDATE recoveries SET link_expires_at = now() - interval '1 second' WHERE user_id = $1", [f.user]);
  await assert.rejects(confirmRecoveryEmail(f.deps, link, WRONG_PIN), failsWith("recovery_invalid"));
  assert.equal((await secretRow(f)).pin_wrong_tries, 0);
});

test("PIN reset applies only after the delay, clears blocking, and issues no credentials", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, true);
  await f.db.query("UPDATE account_secrets SET pin_wrong_tries = 5, pin_blocked_at = now() WHERE user_id = $1", [f.user]);
  const started = await confirmRecoveryEmail(f.deps, await recoveryLink(f), undefined, NEW_PIN);
  const ready = Date.parse(started.ready_at);
  t.mock.timers.enable({ apis: ["Date"], now: ready - 1 });
  assert.equal((await claimRecovery(f.deps, started.recovery_id, started.claim_secret)).state, "waiting");
  assert.ok(await pins.verify(GOOD_PIN, (await secretRow(f)).pin_hash), "the old PIN stays until the delay ends");
  t.mock.timers.setTime(ready);
  const claimed = await claimRecovery(f.deps, started.recovery_id, started.claim_secret);
  assert.equal(claimed.state, "completed");
  assert.equal("password" in claimed, false);
  const row = await secretRow(f);
  assert.ok(await pins.verify(NEW_PIN, row.pin_hash), "the new PIN is applied");
  assert.equal(row.pin_wrong_tries, 0);
  assert.equal(row.pin_blocked_at, null);
  assert.equal(f.stub.passwordCalls, 0);
});

test("MAS rejection or failure before applying a password rolls back token rotation", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  t.mock.method(console, "error", () => {});
  for (const mode of ["reject", "before-apply"]) {
    f.stub.mode = mode;
    await assert.rejects(redeemToken(f.deps, f.token, GOOD_PIN), failsWith("internal"));
    assert.ok((await secretRow(f)).token_hash === secretHash(f.token), "the original token remains after rollback");
    assert.equal(f.stub.passwords.size, 0);
  }
  await redeemToken(f.deps, f.token, GOOD_PIN);
  assert.equal(f.stub.passwords.size, 1);
});

test("a lost MAS response after apply exposes the cross-service gap and permits retry", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  f.stub.mode = "after-apply-drop";
  await assert.rejects(redeemToken(f.deps, f.token, GOOD_PIN));
  const applied = f.stub.passwords.get(f.user.split(":")[0].slice(1));
  assert.ok(applied, "MAS applied a password before the connection dropped");
  assert.ok((await secretRow(f)).token_hash === secretHash(f.token), "Postgres rolled back although MAS changed");
  const retried = await redeemToken(f.deps, f.token, GOOD_PIN);
  assert.ok(retried.password !== applied, "retry applies another password");
  assert.ok((await secretRow(f)).token_hash === secretHash(retried.recovery_token), "retry commits its token");
});

test("a committed token recovery cannot be replayed when the caller loses its result", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  await redeemToken(f.deps, f.token, GOOD_PIN); // Deliberately discard the result, as a caller losing the response would.
  await assert.rejects(redeemToken(f.deps, f.token, GOOD_PIN), failsWith("recovery_invalid"));
  assert.equal(f.stub.passwordCalls, 1);
});

test("record the current completed-email-claim retry behaviour for security review", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, true);
  const started = await confirmRecoveryEmail(f.deps, await recoveryLink(f), GOOD_PIN);
  await f.db.query("UPDATE recoveries SET ready_at = now() - interval '1 second' WHERE id = $1", [started.recovery_id]);
  const first = await claimRecovery(f.deps, started.recovery_id, started.claim_secret);
  const retry = await claimRecovery(f.deps, started.recovery_id, started.claim_secret);
  assert.equal(first.state, "completed");
  assert.equal(retry.state, "completed");
  assert.ok(first.password !== retry.password, "current retries rotate credentials again; this is not replay of the same response");
  assert.ok((await secretRow(f)).token_hash === secretHash(retry.recovery_token), "the last retry token wins");
  assert.equal(f.stub.passwordCalls, 2);
});
