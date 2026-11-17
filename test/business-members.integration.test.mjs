import assert from "node:assert/strict";
import { test } from "node:test";
import { businessRoutes } from "../dist/business-routes.js";
import { RecoverySealer, recoveryKeyHash } from "../dist/business-members.js";
import { isolatedDatabase } from "./helpers/database.mjs";

// The member identity's recovery key (ADR 0284 point 34, bipe#1471). Synthetic accounts and keys only.
const shop = "@shop:example.test";
const SERVER = "example.test";

function fakeMas() {
  return {
    async userByUsername(name) { return { id: `mas-${name}` }; },
    async lockUser() {},
    async unlockUser() {},
    async activeSessions(masId) {
      return masId === "mas-shop" ? [{ kind: "oauth2-sessions", id: "s-OWNER", deviceId: "OWNER", createdAt: new Date(Date.now() - 86_400_000).toISOString() }] : [];
    },
    async finishSession() {},
    async createUser(username) { return `mas-${username}`; },
    async setPassword() { return true; },
    async deactivate() {},
  };
}

async function fixture(t) {
  const db = await isolatedDatabase(t);
  await db.query("INSERT INTO signups (user_id, account_type) VALUES ($1, 'company')", [shop]);
  const auth = {
    async userId(header) { return header.split(" ")[1].split("|")[0]; },
    async session(header) { const [userId, deviceId] = header.split(" ")[1].split("|"); return { userId, deviceId: deviceId || null }; },
  };
  const people = { mas: fakeMas(), attest: () => true, serverName: SERVER, synapse: null, sealer: new RecoverySealer("test-phone-key") };
  const app = businessRoutes({ db, auth, apiUrl: "https://api.example.test", siteUrl: "https://site.example.test", clientIp: () => "127.0.0.1", people });
  app.onError((err, c) => c.json(err.body ? err.body() : { error: "internal" }, err.status ?? 500));
  const call = async (method, path, body) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${shop}|OWNER`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  assert.equal((await call("GET", "/v1/me/business/seats")).body.me.role, "owner");
  return { db, call };
}

const RECOVERY = "/v1/me/business/members/recovery";
const SESSION = "/v1/me/business/members/session";

test("two devices that saw no key: the first PUT wins, the second gets 409 recovery_changed", async (t) => {
  const { call } = await fixture(t);
  const first = await call("POST", SESSION, {});
  assert.equal(first.status, 200);
  assert.equal(first.body.recovery_key, undefined);
  assert.equal((await call("PUT", RECOVERY, { recovery_key: "key-a", replaces: null })).status, 204);
  const late = await call("PUT", RECOVERY, { recovery_key: "key-b", replaces: null });
  assert.equal(late.status, 409);
  assert.equal(late.body.error, "recovery_changed");
  assert.equal((await call("POST", SESSION, {})).body.recovery_key, "key-a");
});

test("replaces with the stored key's hash stores the new key; a stale hash gets 409", async (t) => {
  const { call } = await fixture(t);
  await call("POST", SESSION, {});
  assert.equal((await call("PUT", RECOVERY, { recovery_key: "key-a", replaces: null })).status, 204);
  assert.equal((await call("PUT", RECOVERY, { recovery_key: "key-b", replaces: recoveryKeyHash("key-a") })).status, 204);
  assert.equal((await call("PUT", RECOVERY, { recovery_key: "key-c", replaces: recoveryKeyHash("key-a") })).status, 409);
  assert.equal((await call("POST", SESSION, {})).body.recovery_key, "key-b");
});

test("two PUTs at the same time with the same replaces: one 204 and one 409", async (t) => {
  const { call } = await fixture(t);
  await call("POST", SESSION, {});
  const answers = await Promise.all([
    call("PUT", RECOVERY, { recovery_key: "key-a", replaces: null }),
    call("PUT", RECOVERY, { recovery_key: "key-b", replaces: null }),
  ]);
  assert.deepEqual(answers.map((a) => a.status).sort(), [204, 409]);
});

test("a body without replaces (apps before bipe#1471) replaces with no check; a bad hash is refused", async (t) => {
  const { call } = await fixture(t);
  await call("POST", SESSION, {});
  assert.equal((await call("PUT", RECOVERY, { recovery_key: "key-a" })).status, 204);
  assert.equal((await call("PUT", RECOVERY, { recovery_key: "key-b" })).status, 204);
  assert.equal((await call("POST", SESSION, {})).body.recovery_key, "key-b");
  assert.equal((await call("PUT", RECOVERY, { recovery_key: "key-c", replaces: "ABC" })).status, 400);
});

test("no member identity yet: 404 not_found", async (t) => {
  const { call } = await fixture(t);
  assert.equal((await call("PUT", RECOVERY, { recovery_key: "key-a", replaces: null })).status, 404);
});
