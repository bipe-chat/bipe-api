import assert from "node:assert/strict";
import { test } from "node:test";
import { ProfileFacts } from "../dist/profile-facts.js";
import { deletePhoto, saveProfile } from "../dist/profiles.js";
import { isolatedDatabase } from "./helpers/database.mjs";

// bipe#598, ADR 0049. Synthetic IDs only. A fake Synapse pool answers the profiles and users queries.
function fakeSynapse() {
  const state = { profiles: new Map(), users: new Map() };
  return {
    state,
    async query(sql, params) {
      if (sql.includes("FROM profiles")) {
        const [after, limit] = params;
        const rows = [...state.profiles.entries()].filter(([id]) => id > after).sort(([a], [b]) => (a < b ? -1 : 1)).slice(0, limit)
          .map(([user_id, p]) => ({ user_id, displayname: p.name, avatar_url: p.avatar }));
        return { rows };
      }
      if (sql.includes("FROM users")) {
        return { rows: params[0].filter((n) => state.users.has(n)).map((name) => ({ name, creation_ts: state.users.get(name) })) };
      }
      throw new Error(`unexpected query ${sql}`);
    },
  };
}

test("a first sync records no change; later name and photo changes become dates without values", async (t) => {
  const db = await isolatedDatabase(t);
  const synapse = fakeSynapse();
  synapse.state.profiles.set("ana", { name: "Ana Fixture", avatar: "mxc://example.test/a1" });
  synapse.state.users.set("@ana:example.test", Math.floor(Date.now() / 1000) - 3 * 86400);
  const facts = new ProfileFacts(db, { secret: "test-only-secret", serverName: "example.test", synapse });
  assert.equal(await facts.sync(), 0);
  synapse.state.profiles.set("ana", { name: "Ana Changed", avatar: "mxc://example.test/a2" });
  assert.equal(await facts.sync(), 2);
  assert.equal(await facts.sync(), 0);
  const { facts: [ana] } = await facts.facts(["@ana:example.test"]);
  assert.equal(ana.name_changes.length, 1);
  assert.equal(ana.photo_changes.length, 1);
  assert.ok(Math.abs(Date.parse(ana.created_at) - (Date.now() - 3 * 86400_000)) < 5000);
  const stored = JSON.stringify((await db.query("SELECT * FROM profile_snapshots")).rows) + JSON.stringify((await db.query("SELECT * FROM profile_changes")).rows);
  for (const value of ["Ana Fixture", "Ana Changed", "mxc://example.test/a1", "mxc://example.test/a2"]) assert.ok(!stored.includes(value));
});

test("unknown IDs are absent, old changes go, and public profile edits count", async (t) => {
  const db = await isolatedDatabase(t);
  const facts = new ProfileFacts(db, { serverName: "example.test" });
  assert.deepEqual(await facts.facts(["@nobody:example.test"]), { facts: [] });
  await saveProfile(db, "https://api.example.test", "@bia:example.test", { enabled: false, name: "Bia", bio: "" });
  await saveProfile(db, "https://api.example.test", "@bia:example.test", { enabled: false, name: "Bia", bio: "outra" });
  await saveProfile(db, "https://api.example.test", "@bia:example.test", { enabled: false, name: "Beatriz", bio: "" });
  await deletePhoto(db, "https://api.example.test", "@bia:example.test");
  const { facts: [bia] } = await facts.facts(["@bia:example.test"]);
  assert.equal(bia.name_changes.length, 1);
  assert.equal(bia.photo_changes.length, 0);
  await db.query("INSERT INTO profile_changes (user_id, kind, source, changed_at) VALUES ('@bia:example.test', 'photo', 'matrix', now() - interval '31 days')");
  assert.equal(await facts.prune(), 1);
});
