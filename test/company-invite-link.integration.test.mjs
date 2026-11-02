import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createInvite,
  createPersonalInvite,
  inviteConnections,
  inviterReport,
  myInvites,
  previewInvite,
  returnInviteUse,
  revokePersonalInvite,
  takeInviteUse,
} from "../dist/invites.js";
import { isolatedDatabase } from "./helpers/database.mjs";

// bipe#513, ADR 0138 rule 2: a company account made with its owner's invite is never linked to the owner.
// Rows are inserted as an account made before the fix would have them (invite_id set). Synthetic IDs only.
const owner = "@owner:example.test";
const company = "@company:example.test";
const friend = "@friend:example.test";

async function invitedBy(db, inviter, userId, accountType) {
  const invite = await createInvite(db, 1, 30, "test");
  await db.query("UPDATE invites SET created_by = $1 WHERE id = $2", [inviter, invite.id]);
  await db.query("INSERT INTO signups (user_id, invite_id, account_type) VALUES ($1, $2, $3)", [userId, invite.id, accountType]);
}

test("a company account is not an invite pair with the account whose invite made it", async (t) => {
  const db = await isolatedDatabase(t);
  await db.query("INSERT INTO signups (user_id, account_type) VALUES ($1, 'personal')", [owner]);
  await invitedBy(db, owner, company, "company");
  await invitedBy(db, owner, friend, "personal");

  assert.deepEqual((await inviteConnections(db, owner)).user_ids, [friend]);
  assert.deepEqual((await inviteConnections(db, company)).user_ids, []);
  assert.deepEqual((await inviteConnections(db, friend)).user_ids, [owner]);

  const report = await inviterReport(db, 10, "example.test");
  const row = report.find((r) => r.user_id === owner);
  assert.equal(row?.joined, 1);
  assert.equal(row?.downstream, 1);
});

test("an invite a company sign-up took shows as used, holds its slot and cannot be revoked", async (t) => {
  const db = await isolatedDatabase(t);
  const policy = { perUser: 2, respawnDays: 7 };
  const invite = await createPersonalInvite(db, owner, policy, "https://bipe.test");
  const inviteId = await takeInviteUse(db, invite.code);
  assert.equal(String(inviteId), invite.id);
  // The company row keeps no invite_id (bipe#513).
  await db.query("INSERT INTO signups (user_id, account_type) VALUES ($1, 'company')", [company]);

  const mine = await myInvites(db, owner, policy);
  assert.equal(mine.invites.length, 1);
  assert.equal(mine.invites[0].status, "used");
  assert.equal(mine.invites[0].joined_user_id, undefined);
  assert.equal(mine.available, 1);
  await assert.rejects(revokePersonalInvite(db, owner, invite.id), { id: "not_found" });

  // A failed sign-up gives the use back: the invite is pending again.
  await returnInviteUse(db, inviteId);
  assert.equal((await myInvites(db, owner, policy)).invites[0].status, "pending");
});

test("a personal invite lasts 7 days and its preview gives the expiry", async (t) => {
  const db = await isolatedDatabase(t);
  const invite = await createPersonalInvite(db, owner, { perUser: 2, respawnDays: 7 }, "https://bipe.test");
  const days = (Date.parse(invite.expires_at) - Date.now()) / 86_400_000;
  assert.ok(days > 6.9 && days <= 7, `expires in ${days} days`);
  const preview = await previewInvite(db, invite.code);
  assert.equal(preview.valid, true);
  assert.equal(preview.expires_at, invite.expires_at);
});
