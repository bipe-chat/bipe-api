import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hono } from "hono";
import { StaffGate } from "../dist/auth.js";
import { ApiError } from "../dist/errors.js";
import { researchRoutes } from "../dist/research/routes.js";
import { loadMessagingResearch } from "../dist/research/load.js";

// Synthetic content only. Real research is private operator data, excluded from this repository.
const research = {
  version: 1, reviewed: "2026-10-17", reviewAfter: "2026-11-17", title: "Synthetic study",
  summary: "Private synthetic research marker", methodology: [], groups: [], platforms: [],
  strategy: [{ title: "Synthetic direction" }], priorities: [], watchlist: [], sources: [], features: [], snapshot: {},
};

function app() {
  const auth = { userId: async (header) => {
    if (header === "Bearer synthetic-staff") return "@staff:example.test";
    if (header === "Bearer synthetic-member") return "@member:example.test";
    throw new ApiError("unauthorized");
  } };
  const gate = new StaffGate(auth, { isAdmin: async (localpart) => localpart === "staff" });
  const server = new Hono().route("/v1/admin/research", researchRoutes(gate, async () => research));
  server.onError((error, c) => error instanceof ApiError ? c.json(error.body(), error.status) : c.json({ error: "internal" }, 500));
  return server;
}

test("research is withheld for missing/invalid credentials and ordinary members", async () => {
  const server = app();
  for (const [authorization, code] of [[undefined, 401], ["Bearer invalid", 401], ["Bearer synthetic-member", 404]]) {
    const response = await server.request("/v1/admin/research/messaging", { headers: authorization ? { authorization } : {} });
    assert.equal(response.status, code);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const body = await response.json();
    assert.deepEqual(Object.keys(body), ["error"]);
    assert.equal(JSON.stringify(body).includes(research.summary), false);
  }
});

test("MAS staff receives the complete dated study without cacheable content", async () => {
  const response = await app().request("/v1/admin/research/messaging", { headers: { authorization: "Bearer synthetic-staff" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.match(response.headers.get("vary"), /Authorization/);
  const body = await response.json();
  assert.equal(body.reviewed, "2026-10-17");
  assert.equal(body.features.length, research.features.length);
  assert.deepEqual(body.strategy, research.strategy);
});

test("private loader handles absent/malformed data without exposing file or content", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bipe-research-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "messaging.json");
  await assert.rejects(loadMessagingResearch(path), { message: "Internal research is unavailable" });
  await writeFile(path, JSON.stringify({ private: "never include this in an error" }));
  await assert.rejects(loadMessagingResearch(path), { message: "Internal research is unavailable" });
  await writeFile(path, JSON.stringify(research));
  assert.deepEqual(await loadMessagingResearch(path), research);
});

test("public build contains the interface but no internal research payload", { skip: !existsSync(new URL("../../bipe-web/dist/admin/pesquisa/index.html", import.meta.url)) }, () => {
  const html = readFileSync(new URL("../../bipe-web/dist/admin/pesquisa/index.html", import.meta.url), "utf8");
  assert.match(html, /noindex/);
  assert.match(html, /no-referrer/);
  assert.doesNotMatch(html, /data-website-id/);
  assert.equal(html.includes(research.summary), false);
  for (const file of ["sitemap.xml", "llms.txt"]) {
    assert.equal(readFileSync(new URL(`../../bipe-web/dist/${file}`, import.meta.url), "utf8").includes("/admin/pesquisa/"), false);
  }
});
