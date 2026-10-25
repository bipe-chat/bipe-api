import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { accountStatus, claimRecovery } from "../dist/accounts.js";
import { Mailer } from "../dist/mailer.js";
import { Mas } from "../dist/mas.js";
import { finishWebFlow, linkAccount, Links, newNonce, recoverWithLink, startWebFlow, unlinkAccount } from "../dist/links.js";
import { PinHasher } from "../dist/secrets.js";
import { isolatedDatabase } from "./helpers/database.mjs";
import { masStub } from "./helpers/mas.mjs";

// Linked Apple or Google account for recovery (ADR 0096, bipe#305). Synthetic keys and tokens only; the provider
// key and token endpoints are stubs. Assertions never print a token, a nonce or a handoff.
const GOOD_PIN = "49382615";
const WRONG_PIN = "58273916";
const pins = new PinHasher("22".repeat(32));
const goodHash = await pins.hash(GOOD_PIN);
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const { privateKey: otherKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-kid";
const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };
const LINK_CONFIG = {
  PUBLIC_API_URL: "https://api.example.test",
  BIPE_PIN_PEPPER: "33".repeat(32),
  APPLE_APP_IDS: ["chat.bipe.app.next"],
  APPLE_SERVICE_ID: "chat.bipe.app.next.web",
  GOOGLE_WEB_CLIENT_ID: "123-abc.apps.googleusercontent.com",
  GOOGLE_WEB_CLIENT_SECRET: "test-only-google-secret",
};
let sequence = 0;

function idToken(claims, key = privateKey, kid = KID) {
  const now = Math.floor(Date.now() / 1000);
  const part = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${part({ alg: "RS256", kid, typ: "JWT" })}.${part({ iat: now, exp: now + 600, ...claims })}`;
  const signature = createSign("RSA-SHA256").update(body).sign(key).toString("base64url");
  return `${body}.${signature}`;
}

const appleToken = (sub, nonce, extra = {}) => idToken({ iss: "https://appleid.apple.com", aud: "chat.bipe.app.next", sub, nonce, ...extra });

async function fixture(t) {
  const db = await isolatedDatabase(t);
  const stub = await masStub(t);
  const config = { SERVER_NAME: "example.test", MAS_URL: stub.url, MAS_ADMIN_URL: stub.url, MAS_CLIENT_ID: "test-client", MAS_CLIENT_SECRET: "test-only-client-secret", PUBLIC_SITE_URL: "https://bipe.example.test", BIPE_SMTP_HOST: "", BIPE_SMTP_PORT: 587, BIPE_MAIL_FROM: "Bipe <test@example.test>" };
  const google = { nextToken: null, exchanges: [] };
  const fetcher = async (url, init) => {
    if (url.endsWith("/auth/keys") || url.endsWith("/oauth2/v3/certs")) return { keys: [jwk] };
    if (url === "https://oauth2.googleapis.com/token") {
      google.exchanges.push(init.form);
      return { id_token: google.nextToken };
    }
    throw new Error("unexpected fetch");
  };
  const links = new Links(LINK_CONFIG, fetcher);
  const deps = { db, config, pins, mas: new Mas(config), mailer: new Mailer(config), links };
  const users = [`@case${++sequence}a:example.test`, `@case${sequence}b:example.test`];
  for (const user of users) await db.query("INSERT INTO account_secrets (user_id, device_first, pin_hash) VALUES ($1, true, $2)", [user, goodHash]);
  return { deps, db, links, google, users };
}

function failsWith(code) {
  return (error) => { assert.equal(error.id ?? `${error.name}:${error.code ?? "unknown"}`, code); return true; };
}

test("ID tokens pass only with Bipe's audience, the provider's issuer and key, a nonce and a live time", async () => {
  const links = new Links(LINK_CONFIG, async () => ({ keys: [jwk] }));
  const ok = await links.verifyIdToken("apple", appleToken("sub-1", "n-1"), ["chat.bipe.app.next"]);
  assert.equal(ok.subject, "sub-1");
  const now = Math.floor(Date.now() / 1000);
  for (const bad of [
    appleToken("sub-1", "n-1", { aud: "com.other.app" }),
    appleToken("sub-1", "n-1", { iss: "https://accounts.google.com" }),
    appleToken("sub-1", "n-1", { exp: now - 3600, iat: now - 4000 }),
    appleToken("sub-1", undefined),
    appleToken("sub-1", "n-1", { aud: ["chat.bipe.app.next", "com.other.app"] }),
    idToken({ iss: "https://appleid.apple.com", aud: "chat.bipe.app.next", sub: "sub-1", nonce: "n-1" }, otherKey),
    idToken({ iss: "https://appleid.apple.com", aud: "chat.bipe.app.next", sub: "sub-1", nonce: "n-1" }, privateKey, "unknown-kid"),
    "not.a.token",
  ]) await assert.rejects(links.verifyIdToken("apple", bad, ["chat.bipe.app.next"]), failsWith("recovery_invalid"));
});

test("without its configuration a provider is not offered and its routes answer link_unavailable", async (t) => {
  assert.deepEqual(new Links({ ...LINK_CONFIG, BIPE_PIN_PEPPER: undefined }).providers(), { providers: [] });
  assert.deepEqual(new Links({ PUBLIC_API_URL: "https://api.example.test", BIPE_PIN_PEPPER: "33".repeat(32), APPLE_APP_IDS: [] }).providers(), { providers: [] });
  assert.deepEqual(new Links({ ...LINK_CONFIG, GOOGLE_WEB_CLIENT_SECRET: undefined }).providers().providers.map((p) => p.provider), ["apple"]);
  const f = await fixture(t);
  const bare = { ...f.deps, links: new Links({ ...LINK_CONFIG, APPLE_APP_IDS: [], APPLE_SERVICE_ID: undefined }) };
  await assert.rejects(startWebFlow(bare, "apple", "link", f.users[0], "chat.bipe.app.next"), failsWith("link_unavailable"));
  await assert.rejects(linkAccount(bare, f.users[0], "apple", { id_token: appleToken("s", "n") }), failsWith("link_unavailable"));
});

test("a native Apple link, then a recovery with it: proof first, PIN last, 24-hour delay, alerts", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const [ana, bia] = f.users;
  const { nonce } = await newNonce(f.deps, "link", ana);
  await linkAccount(f.deps, ana, "apple", { id_token: appleToken("apple-ana", nonce) });
  // The nonce works once, and only for the user it was issued to.
  await assert.rejects(linkAccount(f.deps, ana, "apple", { id_token: appleToken("apple-ana", nonce) }), failsWith("recovery_invalid"));
  const other = await newNonce(f.deps, "link", ana);
  await assert.rejects(linkAccount(f.deps, bia, "apple", { id_token: appleToken("apple-bia", other.nonce) }), failsWith("recovery_invalid"));
  // The same Apple account cannot serve a second Bipe account.
  const biaNonce = await newNonce(f.deps, "link", bia);
  await assert.rejects(linkAccount(f.deps, bia, "apple", { id_token: appleToken("apple-ana", biaNonce.nonce) }), failsWith("link_taken"));

  const status = await accountStatus(f.deps, ana);
  assert.deepEqual(status.links.map((l) => l.provider), ["apple"]);
  assert.deepEqual(status.link_events.map((e) => [e.provider, e.change]), [["apple", "linked"]]);
  const stored = await f.db.query("SELECT subject_hash FROM account_links WHERE user_id = $1", [ana]);
  assert.match(stored.rows[0].subject_hash, /^[0-9a-f]{64}$/);
  assert.ok(!stored.rows[0].subject_hash.includes("apple-ana"));

  // A link nonce does not serve a recovery.
  const linkNonce = await newNonce(f.deps, "link", ana);
  await assert.rejects(recoverWithLink(f.deps, "apple", { id_token: appleToken("apple-ana", linkNonce.nonce) }, GOOD_PIN), failsWith("recovery_invalid"));
  // An unknown Apple account uses no PIN try.
  const unknown = await newNonce(f.deps, "recovery", null);
  await assert.rejects(recoverWithLink(f.deps, "apple", { id_token: appleToken("apple-nobody", unknown.nonce) }, WRONG_PIN), failsWith("recovery_invalid"));
  const wrong = await newNonce(f.deps, "recovery", null);
  await assert.rejects(recoverWithLink(f.deps, "apple", { id_token: appleToken("apple-ana", wrong.nonce) }, WRONG_PIN), failsWith("pin_wrong"));
  const tries = await f.db.query("SELECT pin_wrong_tries FROM account_secrets WHERE user_id = $1", [ana]);
  assert.equal(tries.rows[0].pin_wrong_tries, 1);

  const right = await newNonce(f.deps, "recovery", null);
  const started = await recoverWithLink(f.deps, "apple", { id_token: appleToken("apple-ana", right.nonce) }, GOOD_PIN);
  assert.equal(started.purpose, "access");
  const hours = (Date.parse(started.ready_at) - Date.now()) / 3_600_000;
  assert.ok(hours > 23.9 && hours <= 24, "24-hour delay");
  const claim = await claimRecovery(f.deps, started.recovery_id, started.claim_secret);
  assert.equal(claim.state, "waiting");
  assert.equal(claim.password, undefined);
  const after = await accountStatus(f.deps, ana);
  assert.deepEqual(after.recoveries.map((r) => [r.method, r.state]), [["apple", "waiting"]]);
});

test("the Google web flow: state, PKCE and nonce at the API, single-use handoff bound to the flow", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const [ana] = f.users;
  const start = await startWebFlow(f.deps, "google", "link", ana, "chat.bipe.app.next");
  const url = new URL(start.url);
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("redirect_uri"), "https://api.example.test/v1/links/callback/google");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  const state = url.searchParams.get("state");
  f.google.nextToken = idToken({ iss: "https://accounts.google.com", aud: LINK_CONFIG.GOOGLE_WEB_CLIENT_ID, sub: "google-ana", nonce: url.searchParams.get("nonce") });
  assert.equal(await finishWebFlow(f.deps, "google", { state: "wrong-state", code: "c" }), null);
  const target = await finishWebFlow(f.deps, "google", { state, code: "the-code" });
  assert.ok(target.startsWith(`chat.bipe.app.next:/link-done?flow=${encodeURIComponent(start.flow_id)}#`));
  assert.equal(f.google.exchanges.length, 1);
  assert.ok(f.google.exchanges[0].code_verifier.length >= 43);
  // The state works once.
  assert.equal(await finishWebFlow(f.deps, "google", { state, code: "the-code" }), null);
  const handoff = target.split("#")[1];
  // The handoff needs its flow ID, and serves only the purpose and user it was started for.
  await assert.rejects(linkAccount(f.deps, ana, "google", { flow_id: "other", handoff }), failsWith("recovery_invalid"));
  await assert.rejects(recoverWithLink(f.deps, "google", { flow_id: start.flow_id, handoff }, GOOD_PIN), failsWith("recovery_invalid"));
  await linkAccount(f.deps, ana, "google", { flow_id: start.flow_id, handoff });
  await assert.rejects(linkAccount(f.deps, ana, "google", { flow_id: start.flow_id, handoff }), failsWith("recovery_invalid"));
  assert.deepEqual((await accountStatus(f.deps, ana)).links.map((l) => l.provider), ["google"]);

  await unlinkAccount(f.deps, ana, "google");
  await assert.rejects(unlinkAccount(f.deps, ana, "google"), failsWith("not_found"));
  const status = await accountStatus(f.deps, ana);
  assert.deepEqual(status.links, []);
  assert.deepEqual(status.link_events.map((e) => e.change), ["unlinked", "linked"]);
});

test("the Apple web flow takes the form_post ID token, and a cancel goes back to the app", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const start = await startWebFlow(f.deps, "apple", "recovery", null, "chat.bipe.app.next.debug");
  const url = new URL(start.url);
  assert.equal(url.searchParams.get("response_mode"), "form_post");
  assert.equal(url.searchParams.get("scope"), null);
  const cancelled = await finishWebFlow(f.deps, "apple", { state: url.searchParams.get("state"), error: "user_cancelled_authorize" });
  assert.equal(cancelled, `chat.bipe.app.next.debug:/link-done?flow=${encodeURIComponent(start.flow_id)}&error=cancelled`);

  const again = await startWebFlow(f.deps, "apple", "recovery", null, "chat.bipe.app.next");
  const params = new URL(again.url).searchParams;
  // A token for another nonce is refused.
  const bad = idToken({ iss: "https://appleid.apple.com", aud: LINK_CONFIG.APPLE_SERVICE_ID, sub: "apple-x", nonce: "other" });
  assert.ok((await finishWebFlow(f.deps, "apple", { state: params.get("state"), idToken: bad })).endsWith("&error=invalid"));
});
