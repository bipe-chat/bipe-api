import assert from "node:assert/strict";
import { test } from "node:test";
import { getWorkHours, setWorkHours } from "../dist/work-hours.js";
import { isolatedDatabase } from "./helpers/database.mjs";

// Work side opening hours (ADR 0138 rule 4, bipe#511). Synthetic accounts only.
function failsWith(code) {
  return (error) => { assert.equal(`${error.id}:${error.reason ?? ""}`.startsWith(code), true, `${error.id}:${error.reason}`); return true; };
}

test("only a company account has opening hours; defaults until saved; the shared rule refuses bad days", { timeout: 30000 }, async (t) => {
  const db = await isolatedDatabase(t);
  await db.query("INSERT INTO signups (user_id, account_type) VALUES ('@shop:example.test', 'company'), ('@ana:example.test', 'personal')");
  await assert.rejects(getWorkHours(db, "@ana:example.test"), failsWith("not_found"));
  await assert.rejects(getWorkHours(db, "@nobody:example.test"), failsWith("not_found"));
  const first = await getWorkHours(db, "@shop:example.test");
  assert.equal(first.enabled, false);
  assert.equal(first.time_zone, "America/Sao_Paulo");
  assert.ok(first.days.length > 0);

  const hours = { enabled: true, time_zone: "America/Manaus", days: [{ day: 6, ranges: [{ start: "09:00", end: "13:00" }] }, { day: 1, ranges: [{ start: "08:00", end: "12:00" }, { start: "13:00", end: "18:00" }] }] };
  const saved = await setWorkHours(db, "@shop:example.test", hours);
  assert.deepEqual(saved.days.map((d) => d.day), [1, 6]);
  assert.deepEqual(await getWorkHours(db, "@shop:example.test"), saved);

  await assert.rejects(setWorkHours(db, "@shop:example.test", { ...hours, days: [{ day: 1, ranges: [{ start: "18:00", end: "08:00" }] }] }), failsWith("bad_request:work_hours_order"));
  await assert.rejects(setWorkHours(db, "@shop:example.test", { ...hours, days: [{ day: 8, ranges: [] }] }), failsWith("bad_request:work_hours_day"));
  await assert.rejects(setWorkHours(db, "@shop:example.test", { ...hours, time_zone: "Mars/Olympus" }), failsWith("bad_request:time_zone"));
  await assert.rejects(setWorkHours(db, "@ana:example.test", hours), failsWith("not_found"));
});
