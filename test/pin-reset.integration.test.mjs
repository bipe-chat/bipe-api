import assert from "node:assert/strict";
import { test } from "node:test";
import { accountStatus, cancelRecovery, claimRecovery, confirmRecoveryEmail, requestRecoveryEmail, setPin, startPinReset } from "../dist/accounts.js";
import { Mailer } from "../dist/mailer.js";
import { Mas } from "../dist/mas.js";
import { newSecret, PinHasher, secretHash } from "../dist/secrets.js";
import { isolatedDatabase } from "./helpers/database.mjs";
import { masStub } from "./helpers/mas.mjs";
import { bipePusher, kinds, pushGateway } from "./helpers/push-gateway.mjs";

// ADR 0283 rule 13 (bipe#1350): reset a forgotten PIN on a signed-in phone. Synthetic fixtures only; assertions never
// print PINs, mail or secrets.
const GOOD_PIN = "49382615";
const NEW_PIN = "72948163";
const OTHER_PIN = "61837294";
const pins = new PinHasher("11".repeat(32));
const goodHash = await pins.hash(GOOD_PIN);
let sequence = 0;

class CapturingMailer extends Mailer {
  messages = [];
  sendLater(_to, _subject, text, _what) { this.messages.push(text); }
}

async function fixture(t, { email = false, pin = true } = {}) {
  const db = await isolatedDatabase(t);
  const stub = await masStub(t);
  const user = `@reset${++sequence}:example.test`;
  const address = `reset${sequence}@example.test`;
  const config = { SERVER_NAME: "example.test", MAS_URL: stub.url, MAS_ADMIN_URL: stub.url, MAS_CLIENT_ID: "test-client", MAS_CLIENT_SECRET: "test-only-client-secret", PUBLIC_SITE_URL: "https://bipe.example.test", BIPE_SMTP_HOST: "unused.invalid", BIPE_SMTP_PORT: 587, BIPE_MAIL_FROM: "Bipe <test@example.test>" };
  const mailer = new CapturingMailer(config);
  const deps = { db, config, pins, mas: new Mas(config), mailer };
  await db.query("INSERT INTO account_secrets (user_id, device_first, pin_hash, token_hash) VALUES ($1, true, $2, $3)", [user, pin ? goodHash : null, secretHash(newSecret())]);
  if (email) await db.query("INSERT INTO recovery_emails (user_id, email, verified_at, lang) VALUES ($1, $2, now(), 'en')", [user, address]);
  return { ...deps, deps, stub, user, address };
}

async function pinHash(f) {
  return (await f.db.query("SELECT pin_hash, pin_blocked_at, pin_session_blocked_at FROM account_secrets WHERE user_id = $1", [f.user])).rows[0];
}

function failsWith(code) {
  return (error) => { assert.equal(error.id ?? `${error.name}:${error.code ?? "unknown"}`, code); return true; };
}

test("the reset waits the full email delay, then the claim applies the new PIN and unblocks it", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  await f.db.query("UPDATE account_secrets SET pin_session_wrong_tries = 5, pin_session_blocked_at = now() WHERE user_id = $1", [f.user]);
  const before = Date.now();
  const started = await startPinReset(f.deps, f.user, NEW_PIN);
  assert.equal(started.purpose, "pin_reset");
  const ready = Date.parse(started.ready_at);
  assert.ok(ready - before >= 24 * 3600_000 - 5000, "the wait is recoveryDelayHours.email");
  const status = await accountStatus(f.deps, f.user);
  const shown = status.recoveries.find((r) => r.id === started.recovery_id);
  assert.equal(shown.method, "email", "older Android builds fail on an unknown method");
  assert.equal(shown.purpose, "pin_reset");
  assert.equal(shown.state, "waiting");
  t.mock.timers.enable({ apis: ["Date"], now: ready - 1 });
  assert.equal((await claimRecovery(f.deps, started.recovery_id, started.claim_secret)).state, "waiting");
  assert.ok(await pins.verify(GOOD_PIN, (await pinHash(f)).pin_hash), "the old PIN stays until the delay ends");
  t.mock.timers.setTime(ready);
  const claimed = await claimRecovery(f.deps, started.recovery_id, started.claim_secret);
  assert.equal(claimed.state, "completed");
  assert.equal("password" in claimed, false);
  const row = await pinHash(f);
  assert.ok(await pins.verify(NEW_PIN, row.pin_hash), "the new PIN is applied");
  assert.equal(row.pin_session_blocked_at, null);
  assert.equal(f.stub.passwordCalls, 0);
});

test("a cancel from another device stops the reset; the old PIN stays", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const started = await startPinReset(f.deps, f.user, NEW_PIN);
  await cancelRecovery(f.deps, f.user, started.recovery_id);
  await f.db.query("UPDATE recoveries SET ready_at = now() - interval '1 second' WHERE id = $1", [started.recovery_id]);
  assert.equal((await claimRecovery(f.deps, started.recovery_id, started.claim_secret)).state, "cancelled");
  assert.ok(await pins.verify(GOOD_PIN, (await pinHash(f)).pin_hash));
  // After a cancel, a new reset may start.
  await startPinReset(f.deps, f.user, OTHER_PIN);
});

test("a second request while one waits is refused, also when the waiting one came by email", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, { email: true });
  await startPinReset(f.deps, f.user, NEW_PIN);
  await assert.rejects(startPinReset(f.deps, f.user, OTHER_PIN), failsWith("pin_reset_pending"));
  const g = await fixture(t, { email: true });
  await requestRecoveryEmail(g.deps, g.address);
  const link = /\/recuperar\/#([A-Za-z0-9_-]{43})/.exec(g.mailer.messages.findLast((m) => m.includes("/recuperar/#")))[1];
  await confirmRecoveryEmail(g.deps, link, undefined, NEW_PIN);
  await assert.rejects(startPinReset(g.deps, g.user, OTHER_PIN), failsWith("pin_reset_pending"));
});

test("two requests at once make one reset", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const results = await Promise.allSettled([startPinReset(f.deps, f.user, NEW_PIN), startPinReset(f.deps, f.user, OTHER_PIN)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const { rows } = await f.db.query("SELECT count(*)::int AS n FROM recoveries WHERE user_id = $1 AND state = 'waiting'", [f.user]);
  assert.equal(rows[0].n, 1);
});

test("a reset whose claim window ended no longer blocks a new one", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const started = await startPinReset(f.deps, f.user, NEW_PIN);
  await f.db.query("UPDATE recoveries SET ready_at = now() - interval '30 days' WHERE id = $1", [started.recovery_id]);
  await startPinReset(f.deps, f.user, OTHER_PIN);
});

test("a weak PIN, or an account with no PIN, is refused and nothing waits", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  await assert.rejects(startPinReset(f.deps, f.user, "12345678"), failsWith("pin_weak"));
  const g = await fixture(t, { pin: false });
  await assert.rejects(startPinReset(g.deps, g.user, NEW_PIN), failsWith("pin_not_set"));
  for (const x of [f, g]) {
    const { rows } = await x.db.query("SELECT count(*)::int AS n FROM recoveries WHERE user_id = $1", [x.user]);
    assert.equal(rows[0].n, 0);
  }
});

test("setting the PIN with the old one cancels a waiting reset", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const started = await startPinReset(f.deps, f.user, NEW_PIN);
  await setPin(f.deps, f.user, OTHER_PIN, GOOD_PIN);
  await f.db.query("UPDATE recoveries SET ready_at = now() - interval '1 second' WHERE id = $1", [started.recovery_id]);
  assert.equal((await claimRecovery(f.deps, started.recovery_id, started.claim_secret)).state, "cancelled");
});

test("the reset alerts the other devices and the recovery email", { timeout: 30000 }, async (t) => {
  const f = await fixture(t, { email: true });
  const gateway = await pushGateway(t);
  f.deps.push = { pushers: async () => [bipePusher("OLDPHONE")], sygnalUrl: gateway.url };
  await startPinReset(f.deps, f.user, NEW_PIN);
  assert.deepEqual(kinds(gateway), ["recovery_started"]);
  assert.equal(f.mailer.messages.length, 1, "one notice to the recovery email");
});
