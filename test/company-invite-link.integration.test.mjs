import assert from "node:assert/strict";
import { test } from "node:test";
import { createInvite, inviteConnections, inviterReport } from "../dist/invites.js";
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
