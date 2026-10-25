import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { test } from "node:test";
import { Theft } from "../dist/theft.js";
import { isolatedDatabase } from "./helpers/database.mjs";

// bipe#600, bipe#268, ADR 0044, ADR 0051. Synthetic IDs only. A fake MAS keeps locks and sessions in memory.
function fakeMas() {
  const state = { locked: new Set(), sessions: [], fail: false };
  return {
    state,
    async userByUsername(name) { return name.startsWith("ghost") ? null : { id: `mas-${name}` }; },
    async lockUser(id) { if (state.fail) throw new Error("mas down"); state.locked.add(id); },
    async unlockUser(id) { state.locked.delete(id); },
    async activeSessions(id) { return state.sessions.filter((s) => s.user === id && !s.finished).map(({ kind, id: sid, deviceId }) => ({ kind, id: sid, deviceId })); },
    async finishSession(session) { state.sessions.find((s) => s.id === session.id).finished = true; },
  };
}

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const signer = {
  signTheft(sub, stolenAt, now) {
    const bytes = Buffer.from(JSON.stringify({ typ: "theft", sub, stolen_at: Math.floor(stolenAt.getTime() / 1000), iat: now, exp: now + 86400 }));
    return { v: 1, kid: "test", payload: bytes.toString("base64url"), sig: sign(null, bytes, privateKey).toString("base64url") };
  },
};
const ana = "@ana:example.test";
const bia = "@bia:example.test";
const cia = "@cia:example.test";

test("guardians: 1 to 3 known accounts, never the owner", async (t) => {
  const db = await isolatedDatabase(t);
  const theft = new Theft(db, fakeMas(), signer, "example.test");
  await assert.rejects(theft.setGuardians(ana, [ana]), (e) => e.reason === "guardian_self");
  await assert.rejects(theft.setGuardians(ana, ["@ghost:example.test"]), (e) => e.reason === "guardian_unknown");
  await assert.rejects(theft.setGuardians(ana, ["@other:elsewhere.test"]), (e) => e.reason === "guardian_unknown");
  await assert.rejects(theft.setGuardians(ana, ["@a:example.test", "@b:example.test", "@c:example.test", "@d:example.test"]), (e) => e.reason === "guardian_too_many");
  const state = await theft.setGuardians(ana, [bia]);
  assert.deepEqual(state.guardians.map((g) => g.user_id), [bia]);
  assert.deepEqual((await theft.state(bia)).guarding, [{ user_id: ana }]);
});

test("only a guardian marks; the mark locks first, ends every session and covers the phone's accounts", async (t) => {
  const db = await isolatedDatabase(t);
  const mas = fakeMas();
  const theft = new Theft(db, mas, signer, "example.test");
  await theft.setGuardians(ana, [bia]);
  await db.query("INSERT INTO signups (user_id, account_type) VALUES ($1, 'company')", ["@loja:example.test"]);
  await theft.recordPhone(ana, "DEV-A", "phone-fixture-0001");
  await theft.recordPhone(cia, "DEV-C", "phone-fixture-0001");
  await theft.recordPhone("@loja:example.test", "DEV-L", "phone-fixture-0001");
  mas.state.sessions.push(
    { kind: "compat-sessions", id: "s1", user: "mas-ana", deviceId: "DEV-A" },
    { kind: "oauth2-sessions", id: "s2", user: "mas-ana", deviceId: "DEV-OLD" },
    { kind: "compat-sessions", id: "s3", user: "mas-cia", deviceId: "DEV-C" },
    { kind: "compat-sessions", id: "s4", user: "mas-loja", deviceId: "DEV-L" },
    { kind: "compat-sessions", id: "s5", user: "mas-loja", deviceId: "DEV-OTHER-SEAT" },
  );
  await assert.rejects(theft.mark(cia, ana), (e) => e.id === "not_found");
  const mark = await theft.mark(bia, ana);
  assert.equal(mark.marked_by, bia);
  assert.deepEqual([...mas.state.locked].sort(), ["mas-ana", "mas-cia"]);
  assert.deepEqual(mas.state.sessions.filter((s) => s.finished).map((s) => s.id).sort(), ["s1", "s2", "s3", "s4"]);
  assert.equal(await theft.isMarked(cia), true);
  assert.equal(await theft.isMarked("@loja:example.test"), false);
  // A second mark is the same mark.
  assert.equal((await theft.mark(bia, ana)).stolen_at, mark.stolen_at);
  assert.equal((await theft.state(bia)).guarding[0].mark.user_id, ana);

  const { marks } = await theft.statements([ana, cia, "@nobody:example.test"]);
  assert.equal(marks.length, 2);
  for (const envelope of marks) {
    assert.ok(verify(null, Buffer.from(envelope.payload, "base64url"), publicKey, Buffer.from(envelope.sig, "base64url")));
    assert.equal(JSON.parse(Buffer.from(envelope.payload, "base64url")).typ, "theft");
  }

  await theft.clear(bia, ana);
  assert.equal(mas.state.locked.size, 0);
  assert.equal(await theft.isMarked(cia), false);
  assert.deepEqual((await theft.statements([ana, cia])).marks, []);
  assert.equal((await theft.state(ana)).last_mark.marked_by, bia);
});

test("a MAS failure keeps the mark and a retry finishes the steps", async (t) => {
  const db = await isolatedDatabase(t);
  const mas = fakeMas();
  const theft = new Theft(db, mas, signer, "example.test");
  await theft.setGuardians(ana, [bia]);
  mas.state.fail = true;
  await assert.rejects(theft.mark(bia, ana), (e) => e.reason === "theft_unavailable");
  assert.equal(await theft.isMarked(ana), true);
  mas.state.fail = false;
  await theft.mark(bia, ana);
  assert.ok(mas.state.locked.has("mas-ana"));
  await theft.clear("staff", ana, true);
  assert.equal(await theft.isMarked(ana), false);
});
