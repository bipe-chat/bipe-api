import assert from "node:assert/strict";
import { test } from "node:test";
import { GROUP_LINK_MAX_SIGNUPS, GroupLinks, RoomRefused, roomFacts, takeGroupSignup } from "../dist/group-links.js";
import { isolatedDatabase } from "./helpers/database.mjs";

// ADR 0184, bipe-chat/bipe#744. Synthetic IDs only. The service account is a fake that keeps the room state in memory.
const BOT = "@grupos:example.test";
const ADMIN = "@admin:example.test";
const MEMBER = "@member:example.test";
const OUTSIDER = "@outsider:example.test";
const ROOM = "!family:example.test";

function fakeRooms({ botLevel = 50, adminLevel = 100 } = {}) {
  const members = new Map([[ADMIN, "join"], [MEMBER, "join"], [BOT, "invite"]]);
  const invites = [];
  return {
    userId: BOT,
    invites,
    members,
    async join(roomId) {
      if (roomId !== ROOM || members.get(BOT) === undefined) throw new RoomRefused("join", 403);
      members.set(BOT, "join");
    },
    async state(roomId) {
      if (roomId !== ROOM || members.get(BOT) !== "join") throw new RoomRefused("state", 403);
      return [
        { type: "m.room.create", state_key: "", sender: ADMIN, content: { room_version: "11" } },
        { type: "m.room.name", state_key: "", sender: ADMIN, content: { name: "Família" } },
        { type: "m.room.power_levels", state_key: "", sender: ADMIN, content: { users: { [ADMIN]: adminLevel, [BOT]: botLevel }, invite: 50 } },
        ...[...members].map(([u, m]) => ({ type: "m.room.member", state_key: u, sender: u, content: { membership: m } })),
      ];
    },
    async invite(roomId, userId) {
      if (members.get(userId) === "ban") throw new RoomRefused("invite", 403);
      invites.push([roomId, userId]);
      members.set(userId, "invite");
    },
  };
}

function links(db, rooms, verified = true) {
  return new GroupLinks({ db, rooms, verified: async () => verified, siteUrl: "https://bipe.example" });
}

test("an admin makes a link; a holder previews it and gets an invite", async (t) => {
  const db = await isolatedDatabase(t);
  const rooms = fakeRooms();
  const gl = links(db, rooms);
  const made = await gl.create(ADMIN, ROOM);
  assert.equal(made.url, `https://bipe.example/g/${made.code}`);
  assert.equal(made.signs_up, true);

  const preview = await gl.preview(`Vem pro grupo Família no Bipe: ${made.url}`);
  assert.deepEqual(preview, { valid: true, name: "Família", members: 2, signs_up: true });

  assert.deepEqual(await gl.join(OUTSIDER, made.code), { room_id: ROOM });
  assert.deepEqual(rooms.invites, [[ROOM, OUTSIDER]]);
  // A member who is already in gets the room and no second invite.
  assert.deepEqual(await gl.join(MEMBER, made.code), { room_id: ROOM });
  assert.equal(rooms.invites.length, 1);

  const { links: listed } = await gl.list(ADMIN, ROOM);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].joined, 1);
  assert.equal(listed[0].signups_left, GROUP_LINK_MAX_SIGNUPS);
});

test("only an admin makes or lists a link; the service account needs invite power", async (t) => {
  const db = await isolatedDatabase(t);
  const rooms = fakeRooms();
  // The service account joins on the first try, so the caller's level can be read.
  await assert.rejects(links(db, rooms).create(MEMBER, ROOM), { id: "not_found" });
  await assert.rejects(links(db, rooms).list(MEMBER, ROOM), { id: "not_found" });
  await assert.rejects(links(db, fakeRooms({ botLevel: 0 })).create(ADMIN, ROOM), { id: "group_link_no_access" });
  await assert.rejects(links(db, fakeRooms()).create(ADMIN, "!other:example.test"), { id: "group_link_no_access" });
  await assert.rejects(links(db, null).create(ADMIN, ROOM), { id: "internal" });
});

test("a link from an admin without a badge does not sign people up", async (t) => {
  const db = await isolatedDatabase(t);
  const made = await links(db, fakeRooms(), false).create(ADMIN, ROOM);
  assert.equal(made.signs_up, false);
  assert.equal(await takeGroupSignup(db, made.code), null);
});

test("sign-ups stop at the cap, and revoked links do nothing", async (t) => {
  const db = await isolatedDatabase(t);
  const rooms = fakeRooms();
  const gl = links(db, rooms);
  const made = await gl.create(ADMIN, ROOM);
  const taken = await takeGroupSignup(db, made.code);
  assert.equal(taken?.roomId, ROOM);
  await db.query("UPDATE group_links SET signups = $1", [GROUP_LINK_MAX_SIGNUPS]);
  assert.equal(await takeGroupSignup(db, made.code), null);
  assert.equal((await gl.preview(made.code)).signs_up, false);

  await gl.revoke(ADMIN, made.id);
  assert.deepEqual(await gl.preview(made.code), { valid: false });
  await assert.rejects(gl.join(OUTSIDER, made.code), { id: "not_found" });
  await assert.rejects(gl.revoke(ADMIN, made.id), { id: "not_found" });
});

test("a new link from the same admin ends the earlier one; a banned person gets no invite", async (t) => {
  const db = await isolatedDatabase(t);
  const rooms = fakeRooms();
  const gl = links(db, rooms);
  const first = await gl.create(ADMIN, ROOM);
  const second = await gl.create(ADMIN, ROOM);
  assert.deepEqual(await gl.preview(first.code), { valid: false });
  assert.equal((await gl.preview(second.code)).valid, true);
  rooms.members.set(OUTSIDER, "ban");
  await assert.rejects(gl.join(OUTSIDER, second.code), { id: "group_link_no_access" });
  // A member who is not an admin cannot revoke it.
  await assert.rejects(gl.revoke(MEMBER, second.id), { id: "not_found" });
});

test("room version 12 creators are admins without an entry in users", () => {
  const facts = roomFacts([
    { type: "m.room.create", state_key: "", sender: ADMIN, content: { room_version: "12" } },
    { type: "m.room.power_levels", state_key: "", sender: ADMIN, content: { users: {}, invite: 0 } },
    { type: "m.room.member", state_key: ADMIN, sender: ADMIN, content: { membership: "join" } },
  ]);
  assert.equal(facts.level(ADMIN), Number.POSITIVE_INFINITY);
  assert.equal(facts.level(MEMBER), 0);
  assert.equal(facts.name, null);
});
