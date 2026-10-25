import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { requestDeletion, runDueDeletions } from "../../dist/deletion.js";
import { createInvite } from "../../dist/invites.js";
import { Mailer } from "../../dist/mailer.js";
import { Mas } from "../../dist/mas.js";
import { PinHasher } from "../../dist/secrets.js";
import { signup } from "../../dist/signup.js";
import { SynapseAdmin } from "../../dist/synapse-admin.js";
import { isolatedDatabase } from "../helpers/database.mjs";

// ADR 0140, bipe#528: account deletion against real MAS 1.26.0 and Synapse v1.162.0 on the disposable local stack
// (test/real/up.sh). It checks what the stub tests assume: MAS gives the API client a urn:synapse:admin:* token,
// Synapse takes it for make_room_admin, the user redaction and deactivate, and the account cannot sign in after.
// Synthetic accounts only, on loopback. Never point this at a real server.

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
  SYNAPSE_URL: SYNAPSE,
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

async function account(d) {
  const invite = await createInvite(d.db, 1, 30, "real-stack");
  return signup(d, { invite_code: invite.code, pin: PIN });
}

async function login(userId, password) {
  const res = await fetch(`${config.MAS_URL}/_matrix/client/v3/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "m.login.password", identifier: { type: "m.id.user", user: userId }, password, initial_device_display_name: "bipe#528" }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function matrix(token, method, path, body) {
  const res = await fetch(`${SYNAPSE}/_matrix/client/v3${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test("a due deletion hands the group over, redacts, and the account cannot sign in", { timeout: 180000 }, async (t) => {
  const db = await isolatedDatabase(t);
  const d = { db, config, pins, mas, mailer: new Mailer(config), synapse: new SynapseAdmin(config, mas), bugReportsDir: "/nonexistent-bipe-test" };
  const owner = await account(d);
  const friend = await account(d);
  const ownerToken = (await login(owner.user_id, owner.password)).body.access_token;
  const friendToken = (await login(friend.user_id, friend.password)).body.access_token;
  assert.ok(ownerToken && friendToken, "both accounts sign in");

  const room = await matrix(ownerToken, "POST", "/createRoom", { name: "Grupo bipe#528", preset: "private_chat", invite: [friend.user_id] });
  assert.equal(room.status, 200);
  const roomId = room.body.room_id;
  assert.equal((await matrix(friendToken, "POST", `/join/${encodeURIComponent(roomId)}`, {})).status, 200);
  const sent = await matrix(ownerToken, "PUT", `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/t1`, { msgtype: "m.text", body: "oi" });
  assert.equal(sent.status, 200);

  const deletion = await requestDeletion(d, owner.user_id, null, PIN, true);
  await db.query("UPDATE account_deletions SET due_at = now() - interval '1 second' WHERE id = $1", [deletion.id]);
  for (let i = 0; i < 60; i++) {
    await db.query("UPDATE account_deletions SET next_try_at = NULL WHERE id = $1", [deletion.id]);
    await runDueDeletions(d);
    const row = (await db.query("SELECT state, last_error FROM account_deletions WHERE id = $1", [deletion.id])).rows[0];
    if (row.state === "done") break;
    assert.equal(row.last_error, null, `deletion step failed: ${row.last_error}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  assert.equal((await db.query("SELECT state FROM account_deletions WHERE id = $1", [deletion.id])).rows[0].state, "done");

  const power = await matrix(friendToken, "GET", `/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels/`);
  assert.equal(power.status, 200);
  assert.ok((power.body.users?.[friend.user_id] ?? 0) >= 100, "the friend owns the group");
  const message = await matrix(friendToken, "GET", `/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(sent.body.event_id)}`);
  assert.equal(message.status, 200);
  assert.deepEqual(message.body.content, {}, "the message is redacted");
  assert.notEqual((await login(owner.user_id, owner.password)).status, 200, "the deleted account cannot sign in");
  assert.notEqual((await matrix(ownerToken, "GET", "/account/whoami")).status, 200, "the old session is gone");
  const masUser = await mas.userState(owner.user_id.slice(1).split(":")[0]);
  assert.equal(masUser?.deactivated, true);
});
