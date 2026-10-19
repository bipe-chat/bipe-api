import assert from "node:assert/strict";
import { test } from "node:test";
import { Mas } from "../dist/mas.js";
import { finishWebLink, Geo } from "../dist/weblink.js";
import { masStub } from "./helpers/mas.mjs";

// Web sign-in approval (ADR 0118, bipe#389) against a MAS admin API stub. No database.

async function fixture(t) {
  const stub = await masStub(t);
  const mas = new Mas({ MAS_URL: stub.url, MAS_ADMIN_URL: stub.url, MAS_CLIENT_ID: "test-client", MAS_CLIENT_SECRET: "test-only-client-secret" });
  // The stub answers by-username with the username as the MAS user id.
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  stub.sessions.push(
    { id: "staff-browser", user: "ana", created_at: ago(3 * 86_400_000), finished: false },
    { id: "before-flow", user: "ana", created_at: ago(10 * 60_000), finished: false },
    { id: "slack", user: "ana", created_at: ago(5 * 60_000 + 30_000), finished: false },
    { id: "web-view", user: "ana", created_at: ago(2 * 60_000), finished: false },
    { id: "already-finished", user: "ana", created_at: ago(60_000), finished: true },
    { id: "other-user", user: "bia", created_at: ago(60_000), finished: false },
  );
  const finished = () => stub.sessions.filter((s) => s.finished).map((s) => s.id).sort();
  return { stub, mas, finished, since: ago(5 * 60_000) };
}

test("finish ends only the caller's sessions that started during the flow", async (t) => {
  const { mas, finished, since } = await fixture(t);
  assert.equal(await finishWebLink(mas, "@ana:example.test", since), 2);
  assert.deepEqual(finished(), ["already-finished", "slack", "web-view"]);
});

test("finish keeps older sessions when MAS ignores the created-after filter", async (t) => {
  const { stub, mas, finished, since } = await fixture(t);
  stub.options.ignoreCreatedAfter = true;
  assert.equal(await finishWebLink(mas, "@ana:example.test", since), 2);
  assert.deepEqual(finished(), ["already-finished", "slack", "web-view"]);
});

test("finish rejects a since that is too old, in the future or not a time", async (t) => {
  const { mas, finished } = await fixture(t);
  for (const since of [new Date(Date.now() - 16 * 60_000).toISOString(), new Date(Date.now() + 3 * 60_000).toISOString(), "yesterday"]) {
    await assert.rejects(finishWebLink(mas, "@ana:example.test", since), (e) => e.id === "bad_request" && e.reason === "since");
  }
  assert.deepEqual(finished(), ["already-finished"]);
});

test("place returns {} without a database and rejects input that is not an IP", () => {
  const geo = new Geo(undefined);
  assert.equal(geo.enabled, false);
  assert.deepEqual(geo.place("200.160.0.8"), {});
  assert.deepEqual(geo.place("2804:14c::1"), {});
  for (const ip of ["", "not-an-ip", "200.160.0.8:443", "http://200.160.0.8"]) {
    assert.throws(() => geo.place(ip), (e) => e.id === "bad_request" && e.reason === "ip");
  }
});

test("place returns {} when the database file is missing", () => {
  const geo = new Geo("/nonexistent/bipe-test/dbip-city-lite.mmdb");
  assert.equal(geo.enabled, false);
  assert.deepEqual(geo.place("200.160.0.8"), {});
});
