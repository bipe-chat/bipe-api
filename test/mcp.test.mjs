import assert from "node:assert/strict";
import { test } from "node:test";
import { handleMcp, publicTools } from "../dist/mcp.js";

// Public MCP server (ADR 0130, ADR 0210, bipe#438): JSON-RPC handling and what each tool may say. No database.

const payload = (p) => Buffer.from(JSON.stringify(p)).toString("base64url");
const profiles = {
  loja: {
    handle: "loja",
    name: "Loja da Ana",
    bio: "Bolos sob encomenda",
    photo_url: "https://api.bipe.chat/v1/profiles/loja/photo?v=1",
    badge: { v: 1, kid: "k", sig: "s", payload: payload({ sub: "@x:bipe.net.br", lvl: "cnpj", name: "Loja da Ana", legal_name: "Ana Bolos LTDA", cnpj: "12345678000190", checked_month: "2026-10", msk: "m" }) },
  },
  pessoa: { handle: "pessoa", name: "Pessoa", badge: { v: 1, kid: "k", sig: "s", payload: payload({ sub: "@p:bipe.net.br", lvl: "govbr", name: "Pessoa" }) } },
};
const lookup = async (h) => profiles[h] ?? null;
const call = (msg) => handleMcp(JSON.stringify(msg), lookup, "https://bipe.chat");
const tool = async (name, args) => (await call({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).body.result;

test("initialize answers with the asked version when known, else the newest", async () => {
  const known = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  assert.equal(known.status, 200);
  assert.equal(known.body.result.protocolVersion, "2025-03-26");
  assert.deepEqual(known.body.result.capabilities, { tools: { listChanged: false } });
  const unknown = await call({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  assert.equal(unknown.body.result.protocolVersion, "2025-06-18");
});

test("tools/list lists only the public tools of the registry", async () => {
  const { body } = await call({ jsonrpc: "2.0", id: "a", method: "tools/list" });
  assert.deepEqual(body.result.tools.map((t) => t.name).sort(), ["check_cnpj_seal", "get_public_profile", "resolve_handle"]);
  assert.deepEqual(publicTools().map((t) => t.name).sort(), body.result.tools.map((t) => t.name).sort());
  for (const t of body.result.tools) assert.equal(t.annotations.readOnlyHint, true);
});

test("a notification gets 202 and no body", async () => {
  assert.deepEqual(await call({ jsonrpc: "2.0", method: "notifications/initialized" }), { status: 202 });
});

test("bad JSON is a parse error with 400; a batch and a wrong version are invalid requests", async () => {
  const bad = await handleMcp("{nope", lookup, "https://bipe.chat");
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, -32700);
  assert.equal((await call([{ jsonrpc: "2.0", id: 1, method: "ping" }])).body.error.code, -32600);
  assert.equal((await call({ jsonrpc: "1.0", id: 1, method: "ping" })).body.error.code, -32600);
  assert.equal((await call({ jsonrpc: "2.0", id: 1, method: "resources/list" })).body.error.code, -32601);
  assert.equal((await call({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_chat", arguments: {} } })).body.error.code, -32602);
});

test("resolve_handle gives the name and the page, never a Matrix ID", async () => {
  const r = await tool("resolve_handle", { handle: "@Loja" });
  assert.deepEqual(r.structuredContent, { found: true, handle: "loja", name: "Loja da Ana", page: "https://bipe.chat/@loja" });
  assert.ok(!JSON.stringify(r).includes("@x:bipe.net.br"));
});

test("an unknown handle and a profile that is off look the same", async () => {
  assert.deepEqual((await tool("get_public_profile", { handle: "ninguem" })).structuredContent, { found: false, handle: "ninguem" });
  assert.equal((await tool("check_cnpj_seal", { handle: "../x" })).isError, true);
});

test("check_cnpj_seal reads a cnpj badge and ignores a person badge", async () => {
  const seal = (await tool("check_cnpj_seal", { handle: "loja" })).structuredContent;
  assert.equal(seal.verified_company, true);
  assert.deepEqual(seal.seal, { name: "Loja da Ana", legal_name: "Ana Bolos LTDA", cnpj: "12345678000190", checked_month: "2026-10" });
  assert.ok(!("msk" in seal.seal) && !JSON.stringify(seal).includes("@x:bipe.net.br"), "no master key, no Matrix ID");
  const person = (await tool("check_cnpj_seal", { handle: "pessoa" })).structuredContent;
  assert.equal(person.verified_company, false);
  assert.equal(person.seal, undefined);
});

test("get_public_profile shows what the public page shows", async () => {
  const p = (await tool("get_public_profile", { handle: "loja" })).structuredContent;
  assert.deepEqual(Object.keys(p).sort(), ["bio", "found", "handle", "name", "page", "photo_url", "verified_company"]);
});
