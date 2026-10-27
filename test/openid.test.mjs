import assert from "node:assert/strict";
import { test } from "node:test";
import { MatrixAuth } from "../dist/auth.js";

// Core routes with Matrix OpenID tokens (ADR 0168, bipe-chat/bipe#646). Fake fetch; no network.

const config = { SERVER_NAME: "bipe.net.br", SYNAPSE_URL: "http://synapse:8008/" };
const TOKEN = "openid-token-123";

function fixture(answer) {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(String(url));
    const { status = 200, body = {} } = answer(String(url));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { auth: new MatrixAuth(config, fetcher), calls };
}

const code = async (promise) => {
  try {
    await promise;
    return "ok";
  } catch (e) {
    return e.id;
  }
};

test("a user of this homeserver: userinfo on SYNAPSE_URL, cached", async () => {
  const { auth, calls } = fixture(() => ({ body: { sub: "@ana:bipe.net.br" } }));
  const session = await auth.coreSession(`Bearer ${TOKEN}`, "bipe.net.br");
  assert.deepEqual(session, { userId: "@ana:bipe.net.br", deviceId: null });
  assert.equal(calls[0], `http://synapse:8008/_matrix/federation/v1/openid/userinfo?access_token=${TOKEN}`);
  await auth.coreSession(`Bearer ${TOKEN}`, "bipe.net.br");
  assert.equal(calls.length, 1);
});

test("a server outside bipe-servers.json is unauthorized, with no request", async () => {
  const { auth, calls } = fixture(() => ({ body: { sub: "@eve:evil.example" } }));
  for (const server of ["evil.example", "evilbipe.net.br", "bipe.net.br:8448", "BIPE.NET.BR", ""]) {
    assert.equal(await code(auth.coreSession(`Bearer ${TOKEN}`, server)), "unauthorized", server);
  }
  assert.equal(calls.length, 0);
});

test("a server vouches only for its own users", async () => {
  const { auth } = fixture(() => ({ body: { sub: "@ana:evil.example" } }));
  assert.equal(await code(auth.coreSession(`Bearer ${TOKEN}`, "bipe.net.br")), "unauthorized");
});

test("a refused or malformed token is unauthorized", async () => {
  const refused = fixture(() => ({ status: 401, body: { errcode: "M_UNKNOWN_TOKEN" } }));
  assert.equal(await code(refused.auth.coreSession(`Bearer ${TOKEN}`, "bipe.net.br")), "unauthorized");
  assert.equal(await code(refused.auth.coreSession(undefined, "bipe.net.br")), "unauthorized");
  assert.equal(await code(refused.auth.coreSession("Basic abc", "bipe.net.br")), "unauthorized");
  assert.equal(refused.calls.length, 1);
  const noSub = fixture(() => ({ body: {} }));
  assert.equal(await code(noSub.auth.coreSession(`Bearer ${TOKEN}`, "bipe.net.br")), "unauthorized");
});

test("a server error is internal, not unauthorized", async () => {
  const { auth } = fixture(() => ({ status: 502 }));
  assert.equal(await code(auth.coreSession(`Bearer ${TOKEN}`, "bipe.net.br")), "internal");
});
