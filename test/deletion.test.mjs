import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// ADR 0140: the deletion removes every row the data export lists (export.ts). A new table in the export must be
// handled in deletion.ts too: deleted, anonymised or kept on purpose (the CPF hash and the badge record).
test("every table of the data export is handled by the account deletion", () => {
  const exported = readFileSync(new URL("../src/export.ts", import.meta.url), "utf8");
  const deletion = readFileSync(new URL("../src/deletion.ts", import.meta.url), "utf8");
  const tables = new Set([...exported.matchAll(/FROM ([a-z_]+) WHERE/g)].map((m) => m[1]));
  assert.ok(tables.size > 20, "the export lists its tables");
  // account_deletions is the request itself; growth_events go through Growth.forget, bug_reports through forgetBugReports.
  const elsewhere = new Set(["account_deletions"]);
  const missing = [...tables].filter((t) => !elsewhere.has(t) && !new RegExp(`\\b${t}\\b`).test(deletion));
  assert.deepEqual(missing, []);
  assert.match(deletion, /growth\?\.forget/);
  assert.match(deletion, /forgetBugReports/);
});
