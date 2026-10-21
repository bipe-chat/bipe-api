import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { redeemToken } from "../../dist/accounts.js";
import { createInvite } from "../../dist/invites.js";
import { Mailer } from "../../dist/mailer.js";
import { Mas } from "../../dist/mas.js";
import { PinHasher } from "../../dist/secrets.js";
import { signup } from "../../dist/signup.js";
import { finishWebLink } from "../../dist/weblink.js";
import { isolatedDatabase } from "../helpers/database.mjs";

// bipe#231: the account flows against real MAS 1.26.0, Synapse v1.162.0 and Postgres 17.6 (test/real/up.sh).
// The stub tests in test/*.integration.test.mjs assume how MAS answers; these tests check it.
// Synthetic accounts only. Assertions never print a password, token, PIN or email.

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
function loopbackUrl(name) {
  const raw = process.env[name];
  let url;
  try { url = new URL(raw); } catch { throw new Error(`${name} is not set. Run test/real/up.sh first.`); }
  if (!LOOPBACK.has(url.hostname) || process.env.NODE_ENV === "production") throw new Error(`${name} must be a loopback URL. Public and production stacks are refused.`);
  return url.href.replace(/\/$/, "");
}

const SYNAPSE = loopbackUrl("BIPE_REAL_SYNAPSE_URL");
const config = {
  SERVER_NAME: process.env.BIPE_REAL_SERVER_NAME ?? "bipe.test",
  MAS_URL: loopbackUrl("BIPE_REAL_MAS_URL"),
  MAS_ADMIN_URL: loopbackUrl("BIPE_REAL_MAS_ADMIN_URL"),
  MAS_CLIENT_ID: process.env.BIPE_REAL_MAS_CLIENT_ID,
  MAS_CLIENT_SECRET: process.env.BIPE_REAL_MAS_CLIENT_SECRET,
  APP_ATTEST_APP_IDS: [], APP_ATTEST_ENVIRONMENT: "production",
  SIGNUP_ATTEST_REQUIRED: false, SIGNUP_TERMS_REQUIRED: false, SIGNUP_INVITE_REQUIRED: true,
  PUBLIC_SITE_URL: "https://bipe.example.test", BIPE_SMTP_HOST: "", BIPE_SMTP_PORT: 587, BIPE_MAIL_FROM: "Bipe <test@example.test>",
};
const mas = new Mas(config);
const pins = new PinHasher(randomBytes(32).toString("hex"));
const PIN = "49382615";
// Every secret that the tests make or receive. The last test checks that no container log holds one.
const secrets = [];
const keep = (...values) => { secrets.push(...values.filter(Boolean)); return values[0]; };
const failsWith = (id) => (error) => { assert.equal(error.id, id); return true; };

async function deps(t) {
  const db = await isolatedDatabase(t);
  return { db, config, pins, mas, mailer: new Mailer(config) };
}

async function deviceFirstAccount(d) {
  const invite = await createInvite(d.db, 1, 30, "real-stack");
  const made = await signup(d, { invite_code: invite.code, pin: PIN });
  keep(made.password, made.recovery_token, invite.code);
  return made;
}

/** Matrix password login with the full Matrix ID, through the MAS compatibility layer, as the apps do it. */
async function login(userId, password) {
  const res = await fetch(`${config.MAS_URL}/_matrix/client/v3/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "m.login.password", identifier: { type: "m.id.user", user: userId }, password, initial_device_display_name: "bipe#231" }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok) keep(body.access_token, body.refresh_token);
  return { status: res.status, body };
}

async function whoami(accessToken) {
  const res = await fetch(`${SYNAPSE}/_matrix/client/v3/account/whoami`, { headers: { authorization: `Bearer ${accessToken}` } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const localpart = (userId) => userId.slice(1).split(":")[0];

test("device-first sign-up makes an account that signs in with its full Matrix ID and works on Synapse", { timeout: 60000 }, async (t) => {
  const d = await deps(t);
  const made = await deviceFirstAccount(d);
  assert.match(made.user_id, /^@[a-z2-7]{12}:bipe\.test$/);
  const session = await login(made.user_id, made.password);
  assert.equal(session.status, 200, "compatibility login with the hidden password");
  assert.equal(session.body.user_id, made.user_id);
  assert.equal(typeof session.body.device_id, "string");
  const me = await whoami(session.body.access_token);
  assert.equal(me.status, 200, "Synapse accepts the MAS session");
  assert.equal(me.body.user_id, made.user_id);
  assert.equal(me.body.device_id, session.body.device_id);
});

test("createUser answers null for a username that exists, so sign-up picks another localpart", { timeout: 30000 }, async () => {
  const name = `taken${randomBytes(6).toString("hex")}`;
  assert.equal(typeof (await mas.createUser(name)), "string");
  assert.equal(await mas.createUser(name), null);
});

test("token recovery: the new password signs in, the old one fails, the token works once", { timeout: 60000 }, async (t) => {
  const d = await deps(t);
  const made = await deviceFirstAccount(d);
  const before = await login(made.user_id, made.password);
  assert.equal(before.status, 200);

  const again = await redeemToken(d, made.recovery_token, PIN);
  keep(again.password, again.recovery_token);
  assert.equal(again.user_id, made.user_id);
  assert.notEqual(again.recovery_token, made.recovery_token);

  assert.equal((await login(made.user_id, again.password)).status, 200, "new password signs in");
  assert.equal((await login(made.user_id, made.password)).status, 403, "old password is refused");
  await assert.rejects(redeemToken(d, made.recovery_token, PIN), failsWith("recovery_invalid"));

  // AGENTS.md "Unverified (2026-10-13)": MAS keeps the old device's sessions when the admin API sets a new
  // password. If this fails, MAS ends them: update AGENTS.md and the recovery policy (#170), do not flip the assert.
  assert.equal((await whoami(before.body.access_token)).status, 200, "old device session is kept after set-password");
});

test("beta sign-up puts the email in MAS, and emailOwner reads attributes.user_id", { timeout: 60000 }, async (t) => {
  const d = await deps(t);
  const invite = await createInvite(d.db, 1, 30, "real-stack");
  const email = `beta${randomBytes(6).toString("hex")}@example.test`;
  const password = keep(randomBytes(24).toString("base64url"), invite.code);
  const made = await signup(d, { invite_code: invite.code, email, password });
  const masUser = await mas.userByUsername(localpart(made.user_id));
  assert.ok(masUser);
  assert.equal(await mas.emailInUse(email), true);
  // AGENTS.md "Unverified (2026-10-13)": the user-emails resource has attributes.user_id.
  assert.equal(await mas.emailOwner(email), masUser.id);
  assert.equal(await mas.emailOwner(`none${randomBytes(6).toString("hex")}@example.test`), null);
  assert.equal((await login(made.user_id, password)).status, 200, "beta account signs in by Matrix ID");
});

test("web sign-in finish accepts MAS's session filters and leaves the phone's compatibility session alone", { timeout: 60000 }, async (t) => {
  const d = await deps(t);
  const made = await deviceFirstAccount(d);
  const phone = await login(made.user_id, made.password);
  assert.equal(phone.status, 200);
  const finished = await finishWebLink(mas, made.user_id, new Date(Date.now() - 60_000).toISOString());
  assert.equal(finished, 0, "a compatibility session is not a browser session");
  assert.equal((await whoami(phone.body.access_token)).status, 200);
});

test("no container log holds a password, token or invite code", { timeout: 60000 }, () => {
  const file = process.env.BIPE_REAL_COMPOSE;
  const envFile = process.env.BIPE_REAL_COMPOSE_ENV;
  if (!file || !envFile) return assert.fail("BIPE_REAL_COMPOSE is not set. Run test/real/up.sh first.");
  const logs = execFileSync("docker", ["compose", "-f", file, "--env-file", envFile, "logs", "--no-color"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  assert.ok(secrets.length > 0);
  const leaked = secrets.filter((s) => logs.includes(s)).length;
  assert.equal(leaked, 0, `${leaked} secret value(s) found in the stack logs`);
});
